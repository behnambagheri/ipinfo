#!/usr/bin/env bash
set -euo pipefail
image="${1:-ipinfo:test}"
container="$(docker run -d --read-only --cap-drop ALL --security-opt no-new-privileges -p 127.0.0.1::8080 "$image")"
trap 'docker logs "$container"; docker rm -f "$container" >/dev/null' EXIT
port="$(docker port "$container" 8080/tcp | awk -F: '{print $NF}')"
origin="http://127.0.0.1:$port"
for attempt in $(seq 1 30); do
  if curl -fsS "$origin/ip" >/dev/null; then break; fi
  sleep 1
done
curl -fsS "$origin/json?ip=8.8.8.8" | jq -e '.ip == "8.8.8.8" and .country_iso == "US" and .asn == "AS15169"'
curl -fsS "$origin/json?ip=2606:4700:4700::1111" | jq -e '.ip == "2606:4700:4700::1111"'
curl -fsS -A 'Mozilla/5.0' -H 'Accept: text/html' "$origin/" > /tmp/ipinfo-container.html
grep -Fq 'IPinfo — bea.sh' /tmp/ipinfo-container.html
actual="$(curl -fsS "$origin/ip")"
spoofed="$(curl -fsS -H 'X-Forwarded-For: 203.0.113.10' -H 'X-Real-IP: 203.0.113.20' "$origin/ip")"
test "$actual" = "$spoofed"
# A requested family must match the visitor or fail explicitly, never fall back.
if [[ "$actual" == *:* ]]; then matching=6; other=4; else matching=4; other=6; fi
test "$(curl -fsS "$origin/ip?family=$matching")" = "$actual"
test "$(curl -sS -o /tmp/ipinfo-family-error.json -w '%{http_code}' "$origin/json?family=$other")" = 503
jq -e '.error | contains("switching is unavailable")' /tmp/ipinfo-family-error.json
test "$(curl -sS -o /dev/null -w '%{http_code}' "$origin/json?ip=8.8.8.8&family=4")" = 400
grep -Fq 'family=4' /tmp/ipinfo-container.html
if grep -Fq 'api.ipify.org' /tmp/ipinfo-container.html; then exit 1; fi
