package http

import (
	"bytes"
	"embed"
	"net/http"
	"path"
	"time"
)

//go:embed pwa-assets
var pwaAssets embed.FS

// Serve embedded public assets without changing echoip's client-IP handling.
func withPWAAssets(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Path
		// Exact file paths only. Never expose filesystem paths or directory listings.
		if name == "/" || path.Clean(name) != name {
			next.ServeHTTP(w, r)
			return
		}
		data, err := pwaAssets.ReadFile("pwa-assets" + name)
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		contentTypes := map[string]string{
			".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
			".webmanifest": "application/manifest+json", ".js": "text/javascript; charset=utf-8", ".html": "text/html; charset=utf-8",
		}
		w.Header().Set("Content-Type", contentTypes[path.Ext(name)])
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if name == "/sw.js" {
			w.Header().Set("Service-Worker-Allowed", "/")
		}
		http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
	})
}
