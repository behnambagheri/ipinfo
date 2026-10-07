package http

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// Family settings use the same names in the container and Worker.
func configuredOrigin(value string) string {
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

func networkConfig() string {
	data, _ := json.Marshal(map[string]string{
		"auto": configuredOrigin(os.Getenv("IPINFO_AUTO_URL")),
		"ipv4": configuredOrigin(os.Getenv("IPINFO_IPV4_URL")),
		"ipv6": configuredOrigin(os.Getenv("IPINFO_IPV6_URL")),
	})
	return string(data)
}

func familyError(w http.ResponseWriter, r *http.Request, status int, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
	}
}

func (s *Server) familyHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Accept")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead || r.URL.Path == "/health" || strings.HasPrefix(r.URL.Path, "/debug/") {
			next.ServeHTTP(w, r)
			return
		}
		q := r.URL.Query()
		values := q["family"]
		family := q.Get("family")
		if len(values) > 1 || (family != "" && family != "auto" && family != "4" && family != "6") {
			familyError(w, r, 400, "family must be auto, 4, or 6, and supplied only once.")
			return
		}
		selected := family == "4" || family == "6"
		if selected && q.Has("ip") {
			familyError(w, r, 400, "family selects your connection and cannot be combined with an explicit ip lookup.")
			return
		}
		required := os.Getenv("IPINFO_REQUIRED_FAMILY")
		if !selected && required != "4" && required != "6" {
			next.ServeHTTP(w, r)
			return
		}
		ip, err := ipFromRequest(s.IPHeaders, r, false)
		if err != nil {
			familyError(w, r, 503, "Client IP is unavailable.")
			return
		}
		actual := "6"
		if ip.To4() != nil {
			actual = "4"
		}
		if (required == "4" || required == "6") && actual != required {
			familyError(w, r, 409, "This endpoint requires an IPv"+required+" connection. Your connection uses IPv"+actual+".")
			return
		}
		if !selected || actual == family {
			next.ServeHTTP(w, r)
			return
		}
		if q.Has("_family_redirect") {
			familyError(w, r, 409, "The configured IPv"+family+" endpoint received IPv"+actual+". Check its DNS and proxy routing.")
			return
		}
		origin := configuredOrigin(os.Getenv("IPINFO_IPV" + family + "_URL"))
		target, err := url.Parse(origin)
		if origin == "" || err != nil || strings.EqualFold(target.Host, r.Host) || ((r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https") && target.Scheme != "https") {
			familyError(w, r, 503, "IPv"+family+" switching is unavailable: configure a reachable IPv"+family+"-only endpoint for this deployment.")
			return
		}
		target.Path, target.RawPath = r.URL.Path, r.URL.RawPath
		q.Set("family", family)
		q.Set("_family_redirect", family)
		target.RawQuery = q.Encode()
		http.Redirect(w, r, target.String(), http.StatusTemporaryRedirect)
	})
}
