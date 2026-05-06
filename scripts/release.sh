#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-}"
PUBLISH="${2:-}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: npm run release -- <version> [--publish]" >&2
  exit 2
fi

if [[ "$VERSION" != <->.<->.<->* ]]; then
  echo "Version must look like 1.2.3" >&2
  exit 2
fi

cd "$ROOT"

node --input-type=module - "$VERSION" <<'NODE'
import fs from 'node:fs';
const version = process.argv[2];
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = version;
fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
NODE

npm run check
npm run build-app

DMG="$ROOT/../LocalBrain-${VERSION}.dmg"
rm -f "$DMG"
npm run package-dmg

if [[ ! -f "$DMG" ]]; then
  echo "DMG was not created at $DMG" >&2
  exit 1
fi

APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/LocalBrain.app/Contents/Info.plist")"
if [[ "$APP_VERSION" != "$VERSION" ]]; then
  echo "App version mismatch: expected $VERSION, got $APP_VERSION" >&2
  exit 1
fi

echo "Built $DMG"

if [[ "$PUBLISH" == "--publish" ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh CLI is required for --publish" >&2
    exit 1
  fi
  git add package.json README.md src app scripts docs
  git commit -m "Release LocalBrain ${VERSION}"
  git tag -f "v${VERSION}"
  git push origin main
  git push origin "v${VERSION}" --force
  gh release create "v${VERSION}" "$DMG#LocalBrain-${VERSION}.dmg" \
    --title "LocalBrain-${VERSION}.dmg" \
    --notes "LocalBrain ${VERSION}" \
    --latest
fi
