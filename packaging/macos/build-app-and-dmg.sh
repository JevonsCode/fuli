#!/usr/bin/env bash
set -euo pipefail

# Package FULI NEXT native macOS FULI.app bundle + compressed .dmg
# Usage: bash packaging/macos/build-app-and-dmg.sh [version] [out_dir]

VERSION="${1:-1.0.0-next.0}"
OUT_DIR="${2:-dist-next}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REL_DIR="$REPO_ROOT/target/release"
DIST_ROOT="$REPO_ROOT/$OUT_DIR"
APP_DIR="$DIST_ROOT/FULI.app"
DMG_PATH="$DIST_ROOT/FULI-${VERSION}-macos.dmg"

for bin in fuli-context fuli fuli-ui; do
  if [[ ! -f "$REL_DIR/$bin" ]]; then
    echo "Missing release binary $REL_DIR/$bin — run 'cargo build --release --workspace' first." >&2
    exit 1
  fi
done

rm -rf "$APP_DIR" "$DMG_PATH"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

cp "$REL_DIR/fuli-context" "$APP_DIR/Contents/MacOS/fuli-context"
cp "$REL_DIR/fuli"         "$APP_DIR/Contents/MacOS/fuli"
cp "$REL_DIR/fuli-ui"      "$APP_DIR/Contents/MacOS/fuli-ui"
chmod +x "$APP_DIR/Contents/MacOS/fuli-context" "$APP_DIR/Contents/MacOS/fuli" "$APP_DIR/Contents/MacOS/fuli-ui"
cp "$REPO_ROOT/LICENSE" "$APP_DIR/Contents/Resources/LICENSE"

# Generate native macOS .icns icon from official 1024px brand icon when sips + iconutil exist
ICON_SRC="$REPO_ROOT/brand/png/app-icon/fuli-app-icon-light-1024.png"
if [[ -f "$ICON_SRC" ]] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  ICONSET="$(mktemp -d)/FULI.iconset"
  mkdir -p "$ICONSET"
  for sz in 16 32 64 128 256 512; do
    sips -z "$sz" "$sz" "$ICON_SRC" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null
    sz2=$((sz * 2))
    sips -z "$sz2" "$sz2" "$ICON_SRC" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP_DIR/Contents/Resources/FULI.icns"
  rm -rf "$(dirname "$ICONSET")"
fi

cat > "$APP_DIR/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>FULI</string>
  <key>CFBundleDisplayName</key>
  <string>FULI</string>
  <key>CFBundleIdentifier</key>
  <string>com.fuli.desktop.next</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleExecutable</key>
  <string>fuli-context</string>
  <key>CFBundleIconFile</key>
  <string>FULI.icns</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>com.fuli.url</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>fuli</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
EOF

# Build compressed .dmg when hdiutil is available (macOS)
if command -v hdiutil >/dev/null 2>&1; then
  DMG_STAGE="$(mktemp -d)"
  cp -R "$APP_DIR" "$DMG_STAGE/FULI.app"
  ln -s /Applications "$DMG_STAGE/Applications"
  hdiutil create -volname "FULI ${VERSION}" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG_PATH"
  rm -rf "$DMG_STAGE"
  ls -lh "$DMG_PATH"
else
  echo "Built app bundle at $APP_DIR (hdiutil unavailable on non-macOS host)"
fi
