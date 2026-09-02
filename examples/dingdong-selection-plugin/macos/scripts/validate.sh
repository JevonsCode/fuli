#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
package_root="${script_dir:h}"
app_bundle="$package_root/dist/DingDong Selection.app"
binary="$app_bundle/Contents/MacOS/DingDongSelection"

cd "$package_root"
/usr/bin/xcrun swift test
"$script_dir/build-app.sh" >/dev/null
/usr/bin/plutil -lint "$app_bundle/Contents/Info.plist"
/usr/bin/codesign --verify --strict --verbose=2 "$app_bundle"

linked_frameworks="$(/usr/bin/otool -L "$binary")"
if print -r -- "$linked_frameworks" | /usr/bin/grep -Eq 'WebKit|Electron|Chromium'; then
  print -u2 "检测到禁止的重型运行时。"
  exit 1
fi

binary_bytes="$(/usr/bin/stat -f %z "$binary")"
print "release_binary_bytes=$binary_bytes"
print "heavy_runtime_dependencies=0"
