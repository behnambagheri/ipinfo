package http

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

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
