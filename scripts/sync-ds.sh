#!/bin/sh
# Re-vendor the Behnam Bagheri Design System (ds/v1 and the brand mark) from the bea.sh repository.
# The copy is served from this app so the Iran mirror works when bea.sh is unreachable.
# Usage: scripts/sync-ds.sh [git ref, default main]
set -eu

REPOSITORY=behnambagheri/bea.sh
REF=${1:-main}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

COMMIT=$(git ls-remote "https://github.com/$REPOSITORY.git" "$REF" | awk 'NR == 1 { print $1 }')
case "$COMMIT" in
  [0-9a-f]*) ;;
  *) COMMIT=$REF ;;
esac
[ "${#COMMIT}" -eq 40 ] || { echo "Cannot resolve $REPOSITORY@$REF to a commit." >&2; exit 1; }

mkdir "$WORK/source"
curl -fsSL "https://codeload.github.com/$REPOSITORY/tar.gz/$COMMIT" | tar -xz -C "$WORK/source" --strip-components=1
[ -f "$WORK/source/ds/v1/tokens.css" ] || { echo "ds/v1 is missing from $REPOSITORY@$COMMIT." >&2; exit 1; }

rm -rf "$ROOT/public/ds/v1"
mkdir -p "$ROOT/public/ds" "$ROOT/public/brand"
cp -R "$WORK/source/ds/v1" "$ROOT/public/ds/v1"
cp "$WORK/source/favicon.svg" "$ROOT/public/brand/bb-mark.svg"
cat > "$ROOT/public/ds/VERSION.txt" <<EOF
Behnam Bagheri Design System v1
Source: https://github.com/$REPOSITORY/tree/$COMMIT/ds/v1
Commit: $COMMIT
Brand mark: favicon.svg from the same commit (public/brand/bb-mark.svg)
Do not edit these files here; change them upstream and run scripts/sync-ds.sh.
EOF
echo "Vendored $REPOSITORY ds/v1 at $COMMIT."
