#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
package_root="${script_dir:h}"
app_bundle="$package_root/dist/DingDong Selection.app"

case "$app_bundle" in
  "$package_root"/dist/*) ;;
  *) print -u2 "拒绝清理未解析的构建目标。"; exit 1 ;;
esac

cd "$package_root"
/usr/bin/xcrun swift build -c release -Xswiftc -Osize --product DingDongSelection

/bin/rm -rf "$app_bundle"
/bin/mkdir -p "$app_bundle/Contents/MacOS" "$app_bundle/Contents/Resources"
/usr/bin/ditto ".build/release/DingDongSelection" "$app_bundle/Contents/MacOS/DingDongSelection"
/usr/bin/ditto "Resources/Info.plist" "$app_bundle/Contents/Info.plist"
/bin/chmod 755 "$app_bundle/Contents/MacOS/DingDongSelection"
/usr/bin/plutil -lint "$app_bundle/Contents/Info.plist"
/usr/bin/codesign --force --sign - --timestamp=none "$app_bundle"
print "$app_bundle"
