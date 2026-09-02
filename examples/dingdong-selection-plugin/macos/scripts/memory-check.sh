#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
package_root="${script_dir:h}"
binary="$package_root/dist/DingDong Selection.app/Contents/MacOS/DingDongSelection"
maximum_rss_kb="${MAX_RSS_KB:-45000}"
maximum_cpu_percent="${MAX_CPU_PERCENT:-1.0}"
maximum_footprint_mb="${MAX_FOOTPRINT_MB:-20}"
warmup_seconds="${WARMUP_SECONDS:-20}"

[[ -x "$binary" ]] || "$script_dir/build-app.sh" >/dev/null
DINGDONG_SKIP_PERMISSION_PROMPT=1 "$binary" >/dev/null 2>&1 &
app_pid=$!
trap '/bin/kill "$app_pid" 2>/dev/null || true; wait "$app_pid" 2>/dev/null || true' EXIT
/bin/sleep "$warmup_seconds"

rss_kb="$(/bin/ps -o rss= -p "$app_pid" | /usr/bin/tr -d ' ')"
cpu_percent="$(/bin/ps -o %cpu= -p "$app_pid" | /usr/bin/xargs)"
footprint_summary="$(/usr/bin/footprint -p "$app_pid" | /usr/bin/awk '/Footprint:/{print $0; exit}')"
footprint_mb="$(print -r -- "$footprint_summary" | /usr/bin/sed -nE 's/.*Footprint: ([0-9]+) MB.*/\1/p')"
[[ -n "$rss_kb" ]] || { print -u2 "无法读取应用内存。"; exit 1; }
[[ -n "$footprint_mb" ]] || { print -u2 "无法读取应用物理占用。"; exit 1; }

print "idle_rss_kb=$rss_kb"
print "idle_cpu_percent=$cpu_percent"
print "physical_$footprint_summary"
print "budget_rss_kb=$maximum_rss_kb"
print "budget_cpu_percent=$maximum_cpu_percent"
print "budget_footprint_mb=$maximum_footprint_mb"
print "warmup_seconds=$warmup_seconds"
(( rss_kb <= maximum_rss_kb )) || { print -u2 "空闲 RSS 超出预算。"; exit 1; }
(( footprint_mb <= maximum_footprint_mb )) || { print -u2 "空闲物理内存超出预算。"; exit 1; }
/usr/bin/awk -v actual="$cpu_percent" -v maximum="$maximum_cpu_percent" \
  'BEGIN { exit !(actual <= maximum) }' || { print -u2 "空闲 CPU 超出预算。"; exit 1; }
