package http

import (
	"bytes"
	"embed"
	"encoding/json"
	"net/http"
	"path"
	"time"
)

//go:embed pwa-assets
var pwaAssets embed.FS

// Serve embedded public assets without changing echoip's client-IP handling.
func (s *Server) databaseDates() map[string]string {
	if reader, ok := s.gr.(interface{ DatabaseDates() map[string]string }); ok {
		return reader.DatabaseDates()
	}
	return map[string]string{}
}

func withPWAAssets(next http.Handler, dates ...func() map[string]string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Path
		if name == "/database-info" {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				w.Header().Set("Allow", "GET, HEAD")
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			metadata := map[string]string{}
			if len(dates) > 0 {
				metadata = dates[0]()
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			if r.Method == http.MethodGet {
				json.NewEncoder(w).Encode(struct {
					Source    string            `json:"source"`
					Databases map[string]string `json:"databases"`
				}{"GeoLite2", metadata})
			}
			return
		}
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
