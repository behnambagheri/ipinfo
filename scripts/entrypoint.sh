#!/bin/sh
set -eu

# Explicit CLI arguments take precedence over environment configuration.
if [ "$#" -gt 0 ]; then
  exec /opt/echoip/echoip "$@"
fi

set -- -l "${ECHOIP_LISTEN:-:8080}" -C "${ECHOIP_CACHE_SIZE:-0}" \
  -t "${ECHOIP_TEMPLATE_DIR:-/data/html}"

# An explicitly empty database path disables that database.
asn_database="${ECHOIP_ASN_DATABASE-/data/geolite2/GeoLite2-ASN.mmdb}"
city_database="${ECHOIP_CITY_DATABASE-/data/geolite2/GeoLite2-City.mmdb}"
country_database="${ECHOIP_COUNTRY_DATABASE-/data/geolite2/GeoLite2-Country.mmdb}"
[ -z "$asn_database" ] || set -- "$@" -a "$asn_database"
[ -z "$city_database" ] || set -- "$@" -c "$city_database"
[ -z "$country_database" ] || set -- "$@" -f "$country_database"

# Split trusted headers on commas without evaluating their contents.
headers="${ECHOIP_TRUSTED_HEADERS-}"
while [ -n "$headers" ]; do
  header="${headers%%,*}"
  case "$header" in
    ''|*[!A-Za-z0-9_-]*)
      printf 'Invalid trusted header: %s\n' "$header" >&2
      exit 1
      ;;
  esac
  set -- "$@" -H "$header"
  case "$headers" in
    *,*) headers="${headers#*,}" ;;
    *) headers='' ;;
  esac
done

for setting in PORT_LOOKUP REVERSE_LOOKUP DISABLE_CUSTOM_IP PROFILING SPONSOR; do
  case "$setting" in
    PORT_LOOKUP) value="${ECHOIP_PORT_LOOKUP:-false}"; flag='-p' ;;
    REVERSE_LOOKUP) value="${ECHOIP_REVERSE_LOOKUP:-true}"; flag='-r' ;;
    DISABLE_CUSTOM_IP) value="${ECHOIP_DISABLE_CUSTOM_IP:-false}"; flag='-L' ;;
    PROFILING) value="${ECHOIP_PROFILING:-false}"; flag='-P' ;;
    SPONSOR) value="${ECHOIP_SPONSOR:-false}"; flag='-s' ;;
  esac
  case "$value" in
    true|1) set -- "$@" "$flag" ;;
    false|0) ;;
    *) printf 'Invalid ECHOIP_%s: use true or false\n' "$setting" >&2; exit 1 ;;
  esac
done

exec /opt/echoip/echoip "$@"
