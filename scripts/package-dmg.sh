#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(/usr/bin/sed -n 's/.*"version": "\(.*\)".*/\1/p' "$ROOT/package.json" | /usr/bin/head -n 1)"
STAMP="$(/bin/date +%Y%m%d-%H%M%S)"
OUT="$ROOT/../LocalBrain-${VERSION}-${STAMP}.dmg"
STAGING="$(/usr/bin/mktemp -d /tmp/localbrain-dmg.XXXXXX)"

/usr/bin/ditto "$ROOT/LocalBrain.app" "$STAGING/LocalBrain.app"
/bin/ln -s /Applications "$STAGING/Applications"

/bin/cat > "$STAGING/先读我.txt" <<'TEXT'
把 LocalBrain.app 拖到 Applications 文件夹。
启动后，右上角状态栏会出现 LocalBrain 图标。
首次启动会把运行文件复制到：
~/Library/Application Support/LocalBrain/runtime
TEXT

/usr/bin/hdiutil create \
  -volname "LocalBrain" \
  -srcfolder "$STAGING" \
  -format UDZO \
  "$OUT"

/bin/echo "$OUT"
