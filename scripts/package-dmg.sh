#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(/usr/bin/sed -n 's/.*"version": "\(.*\)".*/\1/p' "$ROOT/package.json" | /usr/bin/head -n 1)"
STAMP="$(/bin/date +%Y%m%d-%H%M%S)"
OUT="$ROOT/../LocalBrain-${VERSION}-${STAMP}.dmg"
STAGING="$(/usr/bin/mktemp -d /tmp/localbrain-dmg.XXXXXX)"

/usr/bin/ditto "$ROOT/LocalBrain.app" "$STAGING/LocalBrain.app"
/bin/ln -s /Applications "$STAGING/Applications"

/bin/cat > "$STAGING/README.txt" <<'TEXT'
Drag LocalBrain.app into Applications.
After launch, a LocalBrain icon appears in the upper-right macOS menu bar.
On first launch, runtime files are copied to:
~/Library/Application Support/LocalBrain/runtime
TEXT

/usr/bin/hdiutil create \
  -volname "LocalBrain" \
  -srcfolder "$STAGING" \
  -format UDZO \
  "$OUT"

/bin/echo "$OUT"
