#!/usr/bin/env bash
set -euo pipefail
image="${1:-ipinfo:test}"
container="$(docker run -d --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /var/lib/ipinfo/geolite2:rw,uid=10001,gid=10001,mode=0750 -e IPINFO_DATABASE_UPDATE_ENABLED=false -p 127.0.0.1::8080 "$image")"
trap 'docker logs "$container"; docker rm -f "$container" >/dev/null' EXIT
port="$(docker port "$container" 8080/tcp | awk -F: '{print $NF}')"
origin="http://127.0.0.1:$port"
for attempt in $(seq 1 30); do
  if curl -fsS "$origin/healthz" >/dev/null; then break; fi
  sleep 1
done
curl -fsS "$origin/healthz" | jq -e '.status == "ok" and .revision != null and .database_release != null'
curl -fsS "$origin/json?ip=8.8.8.8" | jq -e '.ip == "8.8.8.8" and .country_iso == "US" and .asn == "AS15169"'
curl -fsS "$origin/json?ip=2606:4700:4700::1111" | jq -e '.ip == "2606:4700:4700::1111"'
curl -fsS -A 'Mozilla/5.0' -H 'Accept: text/html' "$origin/" > /tmp/ipinfo-container.html
grep -Fq 'IPinfo — bea.sh' /tmp/ipinfo-container.html
grep -Fq 'href="/manifest.webmanifest"' /tmp/ipinfo-container.html
grep -Fq 'id="database-updates"' /tmp/ipinfo-container.html
curl -fsS "$origin/database-info" | jq -e '.source == "GeoLite2" and ([.databases.ASN, .databases.City, .databases.Country] | all(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")))'
curl -fsS "$origin/manifest.webmanifest" | jq -e '.display == "standalone" and .start_url == "/" and (.icons | length == 3)'
curl -fsS "$origin/sw.js" | grep -Fq 'ipinfo-assets-'
curl -fsS "$origin/offline.html" | grep -Fq 'You’re offline'
curl -fsS "$origin/favicon.ico" -o /tmp/ipinfo-container.ico
test -s /tmp/ipinfo-container.ico
curl -fsSI "$origin/favicon.ico" | grep -iq 'content-type: image/x-icon'
curl -fsSI "$origin/icons/icon-192.png" | grep -iq 'content-type: image/png'
actual="$(curl -fsS "$origin/ip")"
spoofed="$(curl -fsS -H 'X-Forwarded-For: 203.0.113.10' -H 'X-Real-IP: 203.0.113.20' "$origin/ip")"
test "$actual" = "$spoofed"

# The standalone service exposes the same field routes as the Worker.
curl -fsS "$origin/ip-decimal?ip=8.8.8.8" | grep -Fxq '134744072'
curl -fsS "$origin/country-eu?ip=8.8.8.8" | grep -Fxq 'false'
curl -fsS -A 'ipinfo-smoke' "$origin/user-agent" | grep -Fxq 'ipinfo-smoke'
test "$(curl -sS -o /dev/null -w '%{http_code}' "$origin/__geoip/anything")" = 404
test "$(curl -sS -o /dev/null -w '%{http_code}' "$origin/port/80")" = 501
docker exec "$container" sh -c 'test ! -e /opt/echoip && test -f /app/server.mjs'
