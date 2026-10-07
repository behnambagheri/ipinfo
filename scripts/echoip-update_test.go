package geo

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func updateFixture(t *testing.T) (*databaseManager, map[string][]byte) {
	t.Helper()
	files := map[string][]byte{}
	root := t.TempDir()
	for _, name := range databaseNames {
		data, err := os.ReadFile("update-fixtures/GeoLite2-" + name + "-Test.mmdb")
		if err != nil {
			t.Fatal(err)
		}
		files[name] = data
		if err := os.WriteFile(filepath.Join(root, "GeoLite2-"+name+".mmdb"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	r, err := openUpdateReader(root)
	if err != nil {
		t.Fatal(err)
	}
	m := &databaseManager{reader: r, generation: 1, store: t.TempDir(), now: time.Now, clientFactory: updateClient}
	t.Cleanup(func() { closeReader(m.reader) })
	return m, files
}

func sourceServer(t *testing.T, files map[string][]byte, badChecksum *bool) *httptest.Server {
	t.Helper()
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/latest" {
			assets := []map[string]string{}
			for _, name := range databaseNames {
				hash := sha256.Sum256(files[name])
				digest := hex.EncodeToString(hash[:])
				if *badChecksum && name == "Country" {
					digest = strings.Repeat("0", 64)
				}
				assets = append(assets, map[string]string{"name": "GeoLite2-" + name + ".mmdb", "digest": "sha256:" + digest, "browser_download_url": server.URL + "/download/test-release/GeoLite2-" + name + ".mmdb"})
			}
			json.NewEncoder(w).Encode(map[string]interface{}{"tag_name": "test-release", "assets": assets})
			return
		}
		name := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/download/test-release/GeoLite2-"), ".mmdb")
		if data, ok := files[name]; ok {
			w.Write(data)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestDatabaseUpdateAtomicAndPersistent(t *testing.T) {
	m, files := updateFixture(t)
	bad := false
	server := sourceServer(t, files, &bad)
	m.endpoint = server.URL + "/latest"
	m.prefix = server.URL + "/download/"
	if err := m.update(context.Background(), updateConfig{}); err != nil {
		t.Fatal(err)
	}
	if m.Generation() != 2 || m.DatabaseUpdateStatus().LastSuccessfulUpdate == "" {
		t.Fatal("successful update was not activated")
	}
	stamp := m.DatabaseUpdateStatus().LastSuccessfulUpdate
	if err := m.update(context.Background(), updateConfig{}); err != nil {
		t.Fatal(err)
	}
	if m.Generation() != 2 || m.DatabaseUpdateStatus().LastSuccessfulUpdate != stamp {
		t.Fatal("unchanged release invented a new successful update")
	}
	files["Country"] = bytes.ReplaceAll(files["Country"], []byte("United Kingdom"), []byte("Future Kingdom"))
	bad = true
	if err := m.update(context.Background(), updateConfig{}); err == nil {
		t.Fatal("bad checksum was accepted")
	}
	if m.Generation() != 2 || m.DatabaseUpdateStatus().LastSuccessfulUpdate != stamp {
		t.Fatal("failed update changed active database or success time")
	}
	bad = false
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				m.LookupWithGeneration(net.ParseIP("81.2.69.160"))
			}
		}()
	}
	if err := m.update(context.Background(), updateConfig{}); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	country, _ := m.Country(net.ParseIP("81.2.69.160"))
	if country.Name != "Future Kingdom" {
		t.Fatal("new database is not serving")
	}
	r, err := Open("update-fixtures/GeoLite2-Country-Test.mmdb", "update-fixtures/GeoLite2-City-Test.mmdb", "update-fixtures/GeoLite2-ASN-Test.mmdb")
	if err != nil {
		t.Fatal(err)
	}
	restarted := &databaseManager{reader: r, store: m.store, generation: 1}
	restarted.restore()
	defer closeReader(restarted.reader)
	country, _ = restarted.Country(net.ParseIP("81.2.69.160"))
	if country.Name != "Future Kingdom" || restarted.status.LastSuccessfulUpdate == "" {
		t.Fatal("restart lost the successful update")
	}
}

func TestDatabaseUpdateUsesConfiguredProxy(t *testing.T) {
	m, files := updateFixture(t)
	bad := false
	source := sourceServer(t, files, &bad)
	m.endpoint = source.URL + "/latest"
	m.prefix = source.URL + "/download/"
	var mu sync.Mutex
	calls := 0
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		r.RequestURI = ""
		r.Header.Del("Proxy-Authorization")
		response, err := http.DefaultTransport.RoundTrip(r)
		if err != nil {
			t.Error(err)
			w.WriteHeader(502)
			return
		}
		defer response.Body.Close()
		w.WriteHeader(response.StatusCode)
		var data bytes.Buffer
		data.ReadFrom(response.Body)
		w.Write(data.Bytes())
	}))
	defer proxy.Close()
	if err := m.update(context.Background(), updateConfig{Proxy: proxy.URL}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 4 {
		t.Fatalf("proxy handled %d requests, expected release plus three assets", calls)
	}
}

func TestUpdateSettingsDefaultAndConfigReload(t *testing.T) {
	c, interval, err := updateSettings("")
	if err != nil || !c.Enabled || interval != defaultUpdateInterval {
		t.Fatal("default must enable seven-day updates")
	}
	path := filepath.Join(t.TempDir(), "updates.json")
	os.WriteFile(path, []byte(`{"enabled":true,"interval":"24h","proxy":"http://proxy.example:3128"}`), 0600)
	c, interval, err = updateSettings(path)
	if err != nil || interval != 24*time.Hour || c.Proxy == "" {
		t.Fatal("config file was ignored")
	}
	os.WriteFile(path, []byte(`{"enabled":false,"interval":"12h"}`), 0600)
	c, interval, err = updateSettings(path)
	if err != nil || c.Enabled || interval != 12*time.Hour {
		t.Fatal("changed config was not reloaded")
	}
	t.Setenv("ECHOIP_DATABASE_UPDATE_INTERVAL", "2h")
	_, interval, err = updateSettings(path)
	if err != nil || interval != 2*time.Hour {
		t.Fatal("explicit env did not override config")
	}
	t.Setenv("ECHOIP_DATABASE_UPDATE_PROXY", "http://user:private-password@proxy.example:3128")
	c, _, err = updateSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	client, _ := updateClient(c.Proxy)
	defer client.CloseIdleConnections()
	u, _ := url.Parse("https://api.github.com")
	actual, _ := client.Transport.(*http.Transport).Proxy(&http.Request{URL: u})
	if actual.User.Username() != "user" {
		t.Fatal("authenticated proxy was not configured")
	}
	t.Setenv("ECHOIP_DATABASE_UPDATE_INTERVAL", "0s")
	if _, _, err = updateSettings(path); err == nil {
		t.Fatal("zero interval was accepted")
	}
}

func TestCorruptCandidateAndUnreachableSourceKeepWorkingData(t *testing.T) {
	m, files := updateFixture(t)
	bad := false
	files["City"] = []byte("not a MaxMind database")
	source := sourceServer(t, files, &bad)
	m.endpoint = source.URL + "/latest"
	m.prefix = source.URL + "/download/"
	if err := m.update(context.Background(), updateConfig{}); err == nil {
		t.Fatal("corrupt MMDB accepted")
	}
	if m.Generation() != 1 || m.DatabaseUpdateStatus().LastSuccessfulUpdate != "" {
		t.Fatal("failure changed success state")
	}
	country, _ := m.Country(net.ParseIP("81.2.69.160"))
	if country.ISO != "GB" {
		t.Fatal("working database lost")
	}
	source.Close()
	if err := m.update(context.Background(), updateConfig{}); err == nil {
		t.Fatal("unreachable source accepted")
	}
}

func TestUpdaterRunsOnConfiguredInterval(t *testing.T) {
	m, files := updateFixture(t)
	bad := false
	source := sourceServer(t, files, &bad)
	m.prefix = source.URL + "/download/"
	var checks atomic.Int32
	counted := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		checks.Add(1)
		response, err := http.Get(source.URL + "/latest")
		if err != nil {
			t.Error(err)
			w.WriteHeader(502)
			return
		}
		defer response.Body.Close()
		io.Copy(w, response.Body)
	}))
	defer counted.Close()
	m.endpoint = counted.URL
	m.configFile = filepath.Join(t.TempDir(), "updates.json")
	os.WriteFile(m.configFile, []byte(`{"enabled":true,"interval":"1s"}`), 0600)
	ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	go func() { m.run(ctx); close(done) }()
	<-done
	if checks.Load() < 2 {
		t.Fatal("periodic updater did not run again")
	}
	if m.Generation() != 2 {
		t.Fatal("periodic no-change checks reinstalled the same database")
	}
	if m.DatabaseUpdateStatus().Interval != "1s" {
		t.Fatal("configured interval is not reported")
	}
}
