package geo

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	geoip2 "github.com/oschwald/geoip2-golang"
)

const defaultUpdateInterval = 7 * 24 * time.Hour
const releaseEndpoint = "https://api.github.com/repos/P3TERX/GeoLite.mmdb/releases/latest"
const downloadPrefix = "https://github.com/P3TERX/GeoLite.mmdb/releases/download/"

var databaseNames = []string{"ASN", "City", "Country"}

type updateConfig struct {
	Enabled  bool   `json:"enabled"`
	Interval string `json:"interval"`
	Proxy    string `json:"proxy"`
}

type UpdateStatus struct {
	Enabled              bool   `json:"enabled"`
	Interval             string `json:"interval"`
	ProxyInUse           bool   `json:"proxy_in_use"`
	LastAttempt          string `json:"last_attempt,omitempty"`
	LastSuccessfulCheck  string `json:"last_successful_check,omitempty"`
	LastSuccessfulUpdate string `json:"last_successful_update,omitempty"`
	LastError            string `json:"last_error,omitempty"`
}

type updateState struct {
	Generation string            `json:"generation,omitempty"`
	Release    string            `json:"release"`
	UpdatedAt  string            `json:"last_successful_update"`
	Checksums  map[string]string `json:"checksums"`
}

// All three readers switch under one lock. Old mmap readers are closed only
// after in-flight lookups finish; failed downloads never touch the active set.
type databaseManager struct {
	mu            sync.RWMutex
	updateMu      sync.Mutex
	reader        Reader
	generation    uint64
	state         updateState
	status        UpdateStatus
	store         string
	configFile    string
	endpoint      string
	prefix        string
	now           func() time.Time
	clientFactory func(string) (*http.Client, error)
}

func updateSettings(path string) (updateConfig, time.Duration, error) {
	c := updateConfig{Enabled: true, Interval: "168h"}
	if path != "" {
		bytes, err := os.ReadFile(path)
		if err != nil {
			return c, 0, fmt.Errorf("cannot read database update configuration")
		}
		if err := json.Unmarshal(bytes, &c); err != nil {
			return c, 0, fmt.Errorf("invalid database update configuration")
		}
	}
	if v, ok := os.LookupEnv("ECHOIP_DATABASE_UPDATE_ENABLED"); ok {
		switch v {
		case "true", "1":
			c.Enabled = true
		case "false", "0":
			c.Enabled = false
		default:
			return c, 0, fmt.Errorf("invalid database update enabled value")
		}
	}
	if v, ok := os.LookupEnv("ECHOIP_DATABASE_UPDATE_INTERVAL"); ok {
		c.Interval = v
	}
	if v, ok := os.LookupEnv("ECHOIP_DATABASE_UPDATE_PROXY"); ok {
		c.Proxy = v
	}
	interval, err := time.ParseDuration(c.Interval)
	if err != nil || interval < time.Second {
		return c, 0, fmt.Errorf("database update interval must be a duration of at least one second")
	}
	if _, err := updateClient(c.Proxy); err != nil {
		return c, 0, err
	}
	return c, interval, nil
}

func updateClient(proxy string) (*http.Client, error) {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	if proxy != "" {
		u, err := url.Parse(proxy)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "socks5" && u.Scheme != "socks5h") {
			return nil, fmt.Errorf("database update proxy must be an HTTP, HTTPS, or SOCKS5 URL")
		}
		t.Proxy = http.ProxyURL(u)
	}
	return &http.Client{Transport: t, Timeout: 5 * time.Minute, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) >= 6 || r.URL.Scheme != "https" {
			return fmt.Errorf("unsafe database download redirect")
		}
		return nil
	}}, nil
}

func EnableDatabaseUpdates(r Reader, country, city, asn string) Reader {
	store := os.Getenv("ECHOIP_DATABASE_UPDATE_DIR")
	if store == "" {
		store = "/var/lib/ipinfo/geolite2"
	}
	m := &databaseManager{reader: r, generation: 1, store: store, configFile: os.Getenv("ECHOIP_DATABASE_UPDATE_CONFIG"),
		endpoint: releaseEndpoint, prefix: downloadPrefix, now: time.Now, clientFactory: updateClient}
	m.status.Interval = "168h"
	// A build receipt records a real verified download, not the image file mtime.
	if filepath.Dir(country) == filepath.Dir(city) && filepath.Dir(city) == filepath.Dir(asn) {
		if bytes, err := os.ReadFile(filepath.Join(filepath.Dir(country), "release.json")); err == nil {
			var receipt updateState
			if json.Unmarshal(bytes, &receipt) == nil && validChecksums(receipt.Checksums) {
				m.state = receipt
				m.status.LastSuccessfulUpdate = receipt.UpdatedAt
			}
		}
	}
	if country == "" || city == "" || asn == "" {
		m.status.LastError = "Automatic updates require all three databases."
		return m
	}
	if g, ok := r.(*geoip); ok {
		if g.asn.Metadata().DatabaseType != "GeoLite2-ASN" || g.city.Metadata().DatabaseType != "GeoLite2-City" || g.country.Metadata().DatabaseType != "GeoLite2-Country" {
			m.status.LastError = "Automatic updates require GeoLite2 databases."
			return m
		}
	}
	entries, _ := os.ReadDir(m.store)
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), ".download-") {
			os.RemoveAll(filepath.Join(m.store, entry.Name()))
		}
	}
	m.restore()
	go m.run(context.Background())
	return m
}

func (m *databaseManager) Country(ip net.IP) (Country, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.reader.Country(ip)
}
func (m *databaseManager) City(ip net.IP) (City, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.reader.City(ip)
}
func (m *databaseManager) ASN(ip net.IP) (ASN, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.reader.ASN(ip)
}
func (m *databaseManager) IsEmpty() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.reader.IsEmpty()
}
func (m *databaseManager) Generation() uint64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.generation
}
func (m *databaseManager) LookupWithGeneration(ip net.IP) (Country, City, ASN, uint64) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	country, _ := m.reader.Country(ip)
	city, _ := m.reader.City(ip)
	asn, _ := m.reader.ASN(ip)
	return country, city, asn, m.generation
}
func readerDates(r Reader) map[string]string {
	if dates, ok := r.(interface{ DatabaseDates() map[string]string }); ok {
		return dates.DatabaseDates()
	}
	return map[string]string{}
}
func (m *databaseManager) DatabaseDates() map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return readerDates(m.reader)
}
func (m *databaseManager) DatabaseUpdateStatus() UpdateStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status
}
func (m *databaseManager) DatabaseMetadata() (map[string]string, UpdateStatus) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return readerDates(m.reader), m.status
}

func (m *databaseManager) run(ctx context.Context) {
	var lastAttempt time.Time
	var failed bool
	var configFailed bool
	for {
		if ctx.Err() != nil {
			return
		}
		c, interval, err := updateSettings(m.configFile)
		m.mu.Lock()
		m.status.Enabled = c.Enabled && err == nil
		if err == nil {
			m.status.Interval = c.Interval
		} else {
			m.status.Interval = ""
		}
		m.status.ProxyInUse = c.Proxy != ""
		if err != nil {
			m.status.LastError = err.Error()
		} else if configFailed {
			m.status.LastError = ""
		}
		configFailed = err != nil
		m.mu.Unlock()
		wait := time.Minute // Also reread projected ConfigMap settings every minute.
		if err == nil && c.Enabled {
			delay := interval
			if failed && delay > time.Hour {
				delay = time.Hour
			}
			due := lastAttempt.Add(delay)
			if lastAttempt.IsZero() || !m.now().Before(due) {
				lastAttempt = m.now()
				err = m.update(ctx, c)
				failed = err != nil
				if err != nil {
					log.Printf("Database update failed: %s", err)
				}
				continue
			}
			if remaining := due.Sub(m.now()); remaining < wait {
				wait = remaining
			}
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func validChecksums(hashes map[string]string) bool {
	for _, name := range databaseNames {
		bytes, err := hex.DecodeString(hashes[name])
		if err != nil || len(bytes) != sha256.Size {
			return false
		}
	}
	return true
}

func validReleaseTag(tag string) bool {
	if len(tag) == 0 || len(tag) > 128 || tag[0] == '.' {
		return false
	}
	for _, c := range tag {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func stateReader(root string, s updateState) (Reader, error) {
	if len(s.Generation) != 64 || !validChecksums(s.Checksums) {
		return nil, fmt.Errorf("invalid saved database state")
	}
	if _, err := hex.DecodeString(s.Generation); err != nil {
		return nil, fmt.Errorf("invalid saved database generation")
	}
	dir := filepath.Join(root, "generations", s.Generation)
	for _, name := range databaseNames {
		file, err := os.Open(filepath.Join(dir, "GeoLite2-"+name+".mmdb"))
		if err != nil {
			return nil, fmt.Errorf("saved database is missing")
		}
		hash := sha256.New()
		_, err = io.Copy(hash, file)
		file.Close()
		if err != nil || hex.EncodeToString(hash.Sum(nil)) != s.Checksums[name] {
			return nil, fmt.Errorf("saved database checksum mismatch")
		}
	}
	return openUpdateReader(dir)
}

func closeReader(r Reader) {
	if g, ok := r.(*geoip); ok {
		if g.country != nil {
			g.country.Close()
		}
		if g.city != nil {
			g.city.Close()
		}
		if g.asn != nil {
			g.asn.Close()
		}
	}
}

func openUpdateReader(dir string) (Reader, error) {
	g := &geoip{}
	for _, name := range databaseNames {
		r, err := geoip2.Open(filepath.Join(dir, "GeoLite2-"+name+".mmdb"))
		if err != nil {
			closeReader(g)
			return nil, fmt.Errorf("invalid %s database format", name)
		}
		if r.Metadata().DatabaseType != "GeoLite2-"+name {
			r.Close()
			closeReader(g)
			return nil, fmt.Errorf("wrong %s database type", name)
		}
		switch name {
		case "ASN":
			g.asn = r
		case "City":
			g.city = r
		case "Country":
			g.country = r
		}
	}
	return g, nil
}

func (m *databaseManager) restore() {
	bytes, err := os.ReadFile(filepath.Join(m.store, "current.json"))
	if err != nil {
		return
	}
	var s updateState
	if json.Unmarshal(bytes, &s) != nil {
		return
	}
	r, err := stateReader(m.store, s)
	if err != nil {
		log.Print("Saved database update is invalid; using bundled databases.")
		return
	}
	for name, value := range readerDates(m.reader) {
		oldDate, _ := time.Parse(time.RFC3339, value)
		savedDate, _ := time.Parse(time.RFC3339, readerDates(r)[name])
		if savedDate.Before(oldDate) {
			closeReader(r)
			return
		}
	}
	closeReader(m.reader)
	m.reader = r
	m.state = s
	m.status.LastSuccessfulUpdate = s.UpdatedAt
}

func writeState(dir string, s updateState) error {
	bytes, err := json.Marshal(s)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, ".state-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(bytes); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(file.Name(), filepath.Join(dir, "current.json"))
	}
	return err
}

func (m *databaseManager) update(ctx context.Context, c updateConfig) (result error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	m.updateMu.Lock()
	defer m.updateMu.Unlock()
	now := m.now().UTC().Format(time.RFC3339)
	m.mu.Lock()
	m.status.LastAttempt = now
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if result != nil {
			m.status.LastError = result.Error()
		} else {
			m.status.LastError = ""
			m.status.LastSuccessfulCheck = m.now().UTC().Format(time.RFC3339)
		}
	}()
	client, err := m.clientFactory(c.Proxy)
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, m.endpoint, nil)
	if err != nil {
		return fmt.Errorf("invalid database release endpoint")
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("cannot reach database release source")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("database release source returned HTTP %d", response.StatusCode)
	}
	var release struct {
		Tag    string `json:"tag_name"`
		Assets []struct {
			Name   string `json:"name"`
			URL    string `json:"browser_download_url"`
			Digest string `json:"digest"`
		} `json:"assets"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 1024*1024)).Decode(&release) != nil || !validReleaseTag(release.Tag) {
		return fmt.Errorf("invalid database release metadata")
	}
	hashes := make(map[string]string)
	urls := make(map[string]string)
	for _, name := range databaseNames {
		for _, asset := range release.Assets {
			if asset.Name == "GeoLite2-"+name+".mmdb" {
				if asset.URL != m.prefix+release.Tag+"/"+asset.Name || !strings.HasPrefix(asset.Digest, "sha256:") {
					return fmt.Errorf("invalid database asset metadata")
				}
				hashes[name] = strings.TrimPrefix(asset.Digest, "sha256:")
				urls[name] = asset.URL
			}
		}
	}
	if !validChecksums(hashes) {
		return fmt.Errorf("database release lacks verified checksums")
	}
	m.mu.RLock()
	same := true
	for _, name := range databaseNames {
		if m.state.Checksums[name] != hashes[name] {
			same = false
		}
	}
	oldGeneration := m.state.Generation
	oldDates := readerDates(m.reader)
	m.mu.RUnlock()
	if same {
		return nil
	}
	if err := os.MkdirAll(filepath.Join(m.store, "generations"), 0750); err != nil {
		return fmt.Errorf("database update directory is not writable")
	}
	stage, err := os.MkdirTemp(m.store, ".download-")
	if err != nil {
		return fmt.Errorf("cannot create database download directory")
	}
	defer os.RemoveAll(stage)
	for _, name := range databaseNames {
		r, _ := http.NewRequestWithContext(ctx, http.MethodGet, urls[name], nil)
		response, err := client.Do(r)
		if err != nil {
			return fmt.Errorf("cannot download %s database", name)
		}
		if response.StatusCode != http.StatusOK {
			response.Body.Close()
			return fmt.Errorf("%s database download returned HTTP %d", name, response.StatusCode)
		}
		file, err := os.OpenFile(filepath.Join(stage, "GeoLite2-"+name+".mmdb"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0640)
		if err != nil {
			response.Body.Close()
			return fmt.Errorf("cannot save %s database", name)
		}
		hash := sha256.New()
		size, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, 256*1024*1024+1))
		response.Body.Close()
		if copyErr == nil {
			copyErr = file.Sync()
		}
		closeErr := file.Close()
		if copyErr != nil || closeErr != nil || size == 0 || size > 256*1024*1024 {
			return fmt.Errorf("incomplete %s database download", name)
		}
		if hex.EncodeToString(hash.Sum(nil)) != hashes[name] {
			return fmt.Errorf("%s database checksum mismatch", name)
		}
	}
	r, err := openUpdateReader(stage)
	if err != nil {
		return fmt.Errorf("downloaded database format is invalid")
	}
	newDates := readerDates(r)
	for _, name := range databaseNames {
		date, err := time.Parse(time.RFC3339, newDates[name])
		oldDate, _ := time.Parse(time.RFC3339, oldDates[name])
		if err != nil || date.Before(oldDate) || date.After(m.now().Add(24*time.Hour)) {
			closeReader(r)
			return fmt.Errorf("%s database has an invalid or older build date", name)
		}
	}
	closeReader(r)
	hash := sha256.New()
	for _, name := range databaseNames {
		io.WriteString(hash, hashes[name])
	}
	generation := hex.EncodeToString(hash.Sum(nil))
	destination := filepath.Join(m.store, "generations", generation)
	s := updateState{Generation: generation, Release: release.Tag, UpdatedAt: m.now().UTC().Format(time.RFC3339), Checksums: hashes}
	if _, err := os.Stat(destination); os.IsNotExist(err) {
		if err := os.Rename(stage, destination); err != nil {
			return fmt.Errorf("cannot install database generation")
		}
	}
	r, err = stateReader(m.store, s)
	if err != nil {
		return err
	}
	if writeState(m.store, s) != nil {
		closeReader(r)
		return fmt.Errorf("cannot commit database update state")
	}
	m.mu.Lock()
	old := m.reader
	m.reader = r
	m.state = s
	m.generation++
	m.status.LastSuccessfulUpdate = s.UpdatedAt
	closeReader(old)
	m.mu.Unlock()
	// Retain the previous generation for recovery; clean only owned generations.
	entries, _ := os.ReadDir(filepath.Join(m.store, "generations"))
	for _, entry := range entries {
		if entry.IsDir() && len(entry.Name()) == 64 && entry.Name() != generation && entry.Name() != oldGeneration {
			os.RemoveAll(filepath.Join(m.store, "generations", entry.Name()))
		}
	}
	log.Printf("Database update installed: release %s", release.Tag)
	return nil
}
