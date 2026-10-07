package http

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestFamilyRouting(t *testing.T) {
	tests := []struct {
		name, path, ip, endpoint, required string
		status                             int
	}{
		{"default", "/json", "8.8.8.8:1234", "", "", 200},
		{"auto", "/json?family=auto", "[::1]:1234", "", "", 200},
		{"matching-v4", "/json?family=4", "8.8.8.8:1234", "", "", 200},
		{"matching-v6", "/json?family=6", "[::1]:1234", "", "", 200},
		{"mapped-v4", "/json?family=4", "[::ffff:8.8.8.8]:1234", "", "", 200},
		{"missing-endpoint", "/json?family=4", "[::1]:1234", "", "", 503},
		{"redirect", "/json?family=4", "[::1]:1234", "https://v4.example.com", "", 307},
		{"redirect-v6", "/json?family=6", "8.8.8.8:1234", "https://v6.example.com", "", 307},
		{"invalid-endpoint", "/json?family=4", "[::1]:1234", "https://v4.example.com/path", "", 503},
		{"same-host", "/json?family=4", "[::1]:1234", "https://ip.example.com", "", 503},
		{"invalid-selection", "/json?family=ipv4", "8.8.8.8:1234", "", "", 400},
		{"duplicate-selection", "/json?family=4&family=6", "8.8.8.8:1234", "", "", 400},
		{"explicit-lookup", "/json?ip=1.1.1.1&family=4", "8.8.8.8:1234", "", "", 400},
		{"redirect-loop", "/json?family=4&_family_redirect=4", "[::1]:1234", "https://v4.example.com", "", 409},
		{"required-family", "/json", "[::1]:1234", "", "4", 409},
		{"family-independent-health", "/health", "8.8.8.8:1234", "", "6", 200},
		{"missing-peer", "/json?family=4", "invalid", "", "", 503},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("IPINFO_IPV4_URL", tc.endpoint)
			t.Setenv("IPINFO_IPV6_URL", tc.endpoint)
			t.Setenv("IPINFO_REQUIRED_FAMILY", tc.required)
			downstream := 0
			handler := (&Server{}).familyHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { downstream++; w.WriteHeader(200) }))
			r := httptest.NewRequest("GET", "https://ip.example.com"+tc.path, nil)
			r.RemoteAddr = tc.ip
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("got %d: %s; want %d", w.Code, w.Body.String(), tc.status)
			}
			if (downstream == 1) != (tc.status == 200) {
				t.Fatal("unexpected downstream lookup")
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("visitor response must not be cached")
			}
			if tc.status == 307 {
				target, err := url.Parse(w.Header().Get("Location"))
				if err != nil || target.Path != "/json" || target.Query().Get("_family_redirect") == "" || !strings.HasPrefix(target.String(), tc.endpoint) {
					t.Fatal("invalid redirect", target)
				}
			}
		})
	}
}

func TestFamilyHeadAndTrustedHeaders(t *testing.T) {
	t.Setenv("IPINFO_REQUIRED_FAMILY", "")
	t.Setenv("IPINFO_IPV4_URL", "")
	handler := (&Server{IPHeaders: []string{"X-Real-IP"}}).familyHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	r := httptest.NewRequest("HEAD", "https://ip.example.com/ip?family=4", nil)
	r.RemoteAddr = "[::1]:1234"
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 503 || w.Body.Len() != 0 {
		t.Fatal("HEAD must preserve error status without a body")
	}
	r.Header.Set("X-Real-IP", "8.8.8.8")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal("must use the configured trusted client header")
	}
	t.Setenv("IPINFO_IPV6_URL", "http://v6.example.com")
	r = httptest.NewRequest("GET", "http://ip.example.com/ip?family=6", nil)
	r.RemoteAddr = "8.8.8.8:1234"
	r.Header.Set("X-Forwarded-Proto", "https")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 503 {
		t.Fatal("TLS-terminating proxies must not redirect to HTTP")
	}
}

func TestNetworkConfig(t *testing.T) {
	for _, value := range []string{"javascript:alert(1)", "https://user:pass@example.com", "https://example.com/path", "https://example.com?key=value", ""} {
		if configuredOrigin(value) != "" {
			t.Fatal("accepted invalid origin", value)
		}
	}
	if configuredOrigin("https://example.com/") != "https://example.com" {
		t.Fatal("valid origin rejected")
	}
}
