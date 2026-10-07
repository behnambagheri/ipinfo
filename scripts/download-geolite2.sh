#!/bin/sh
set -eu

output_dir="${1:-/data/geolite2}"
mkdir -p "$output_dir"
release_metadata="$(mktemp)"
trap 'rm -f "$release_metadata"' EXIT

# Resolve the release once so all three databases come from the same version.
curl --fail --silent --show-error --location \
  --retry 3 --connect-timeout 15 --max-time 60 \
  --header 'Accept: application/vnd.github+json' \
  --output "$release_metadata" \
  https://api.github.com/repos/P3TERX/GeoLite.mmdb/releases/latest

release_tag="$(jq -er '.tag_name' "$release_metadata")"
printf 'Downloading GeoLite2 databases from release %s\n' "$release_tag"

for database in ASN City Country; do
  filename="GeoLite2-${database}.mmdb"
  asset="$(jq -ce --arg name "$filename" \
    '.assets[] | select(.name == $name)' "$release_metadata")"
  download_url="$(printf '%s' "$asset" | jq -er '.browser_download_url')"
  checksum="$(printf '%s' "$asset" | jq -er \
    '.digest | select(startswith("sha256:")) | sub("^sha256:"; "")')"

  curl --fail --silent --show-error --location \
    --retry 3 --connect-timeout 15 --max-time 300 \
    --output "$output_dir/$filename" "$download_url"
  test -s "$output_dir/$filename"
  printf '%s  %s\n' "$checksum" "$output_dir/$filename" | sha256sum -c -
done
