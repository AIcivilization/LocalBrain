#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/LocalBrain.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
RUNTIME="$RESOURCES/runtime"
ICONSET="$RESOURCES/LocalBrain.iconset"

rm -rf "$APP"
mkdir -p "$MACOS" "$RESOURCES" "$RUNTIME"

swiftc "$ROOT/app/LocalBrainStatusApp.swift" \
  -o "$MACOS/LocalBrain" \
  -framework AppKit \
  -framework Foundation

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>LocalBrain</string>
  <key>CFBundleIdentifier</key>
  <string>local.localbrain.status</string>
  <key>CFBundleName</key>
  <string>LocalBrain</string>
  <key>CFBundleDisplayName</key>
  <string>LocalBrain</string>
  <key>CFBundleIconFile</key>
  <string>LocalBrain</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
PLIST

swift "$ROOT/scripts/make-app-icon.swift" "$ICONSET" "$RESOURCES/LocalBrainStatus.png"
/usr/bin/iconutil -c icns "$ICONSET" -o "$RESOURCES/LocalBrain.icns"
/bin/rm -rf "$ICONSET"

/usr/bin/ditto "$ROOT/app" "$RUNTIME/app"
/usr/bin/ditto "$ROOT/docs" "$RUNTIME/docs"
/usr/bin/ditto "$ROOT/scripts" "$RUNTIME/scripts"
/usr/bin/ditto "$ROOT/src" "$RUNTIME/src"
/bin/cp "$ROOT/package.json" "$RUNTIME/package.json"
/bin/cp "$ROOT/README.md" "$RUNTIME/README.md"
/bin/date '+%Y%m%d%H%M%S' > "$RUNTIME/.runtime-version"

printf 'APPL????' > "$CONTENTS/PkgInfo"
chmod +x "$MACOS/LocalBrain"
codesign --force --deep --sign - --timestamp=none "$APP" >/dev/null
echo "Built $APP"
