package http

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDatabaseDates(t *testing.T) {
	handler := withPWAAssets(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("metadata endpoint reached the IP lookup handler")
	}), func() map[string]interface{} {
		return map[string]interface{}{"source": "GeoLite2", "databases": map[string]string{"ASN": "2026-10-06T08:15:27Z"}}
	})
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(method, "/database-info", nil))
		if method == http.MethodPost {
			if response.Code != http.StatusMethodNotAllowed {
				t.Fatal("POST metadata should be rejected")
			}
			continue
		}
		if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("invalid metadata response")
		}
		if method == http.MethodHead {
			if response.Body.Len() != 0 {
				t.Fatal("HEAD returned metadata body")
			}
			continue
		}
		var info struct {
			Source    string
			Databases map[string]string
		}
		if err := json.Unmarshal(response.Body.Bytes(), &info); err != nil {
			t.Fatal(err)
		}
		if info.Source != "GeoLite2" || info.Databases["ASN"] != "2026-10-06T08:15:27Z" {
			t.Fatal("incorrect database date")
		}
		if _, ok := info.Databases["City"]; ok {
			t.Fatal("invented missing database date")
		}
	}
}

func TestPWAAssets(t *testing.T) {
	handler := withPWAAssets(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	for _, file := range []struct{ path, contentType string }{
		{"/manifest.webmanifest", "application/manifest+json"},
		{"/sw.js", "text/javascript; charset=utf-8"},
		{"/brand/ipinfo.svg", "image/svg+xml"},
		{"/favicon.ico", "image/x-icon"},
		{"/icons/icon-192.png", "image/png"},
		{"/offline.html", "text/html; charset=utf-8"},
	} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(method, file.path, nil))
			if response.Code != http.StatusOK || response.Header().Get("Content-Type") != file.contentType {
				t.Fatalf("%s %s: status %d, type %s", method, file.path, response.Code, response.Header().Get("Content-Type"))
			}
			if method == http.MethodHead && response.Body.Len() != 0 {
				t.Fatal("HEAD returned a body")
			}
			if file.path == "/sw.js" && response.Header().Get("Service-Worker-Allowed") != "/" {
				t.Fatal("service worker scope missing")
			}
		}
	}
	for _, route := range []string{"/", "/json", "/json?ip=8.8.8.8", "/brand/", "/icons/../sw.js", "/missing.svg"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, route, nil))
		if response.Code != http.StatusTeapot {
			t.Fatalf("%s did not reach echoip", route)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/sw.js", nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatal("POST should be rejected")
	}
}
