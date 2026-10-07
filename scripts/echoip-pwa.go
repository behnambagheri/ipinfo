package http

import (
	"bytes"
	"embed"
	"encoding/json"
	"net/http"
	"path"
	"time"

	"github.com/mpolden/echoip/iputil/geo"
)

//go:embed pwa-assets
var pwaAssets embed.FS

// Serve embedded public assets without changing echoip's client-IP handling.
func (s *Server) databaseMetadata() map[string]interface{} {
	if reader, ok := s.gr.(interface {
		DatabaseMetadata() (map[string]string, geo.UpdateStatus)
	}); ok {
		dates, status := reader.DatabaseMetadata()
		return map[string]interface{}{"source": "GeoLite2", "databases": dates, "updates": status}
	}
	if reader, ok := s.gr.(interface{ DatabaseDates() map[string]string }); ok {
		return map[string]interface{}{"source": "GeoLite2", "databases": reader.DatabaseDates()}
	}
	return map[string]interface{}{"source": "GeoLite2", "databases": map[string]string{}}
}

func withPWAAssets(next http.Handler, metadata ...func() map[string]interface{}) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Path
		if name == "/database-info" {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				w.Header().Set("Allow", "GET, HEAD")
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			info := map[string]interface{}{"source": "GeoLite2", "databases": map[string]string{}}
			if len(metadata) > 0 {
				info = metadata[0]()
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			if r.Method == http.MethodGet {
				json.NewEncoder(w).Encode(info)
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
