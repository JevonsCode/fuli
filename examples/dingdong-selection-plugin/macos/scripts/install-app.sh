#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
package_root="${script_dir:h}"
source_app="$package_root/dist/DingDong Selection.app"
install_root="$HOME/Applications"
destination="$install_root/DingDong Selection.app"
destination_binary="$destination/Contents/MacOS/DingDongSelection"

"$script_dir/build-app.sh" >/dev/null
/bin/mkdir -p "$install_root"
temporary_directory="$(/usr/bin/mktemp -d "$install_root/.dingdong-selection-install.XXXXXX")"
backup=""
destination_was_running=false
install_succeeded=false

cleanup() {
  exit_status=$?
  if [[ "$install_succeeded" != true && -n "$backup" && -e "$backup" ]]; then
    if [[ -e "$destination" ]]; then
      /bin/mv "$destination" "$temporary_directory/failed-install.app" 2>/dev/null || true
    fi
    if /bin/mv "$backup" "$destination"; then
      print -u2 "安装失败，已恢复旧版本。"
      if [[ "$destination_was_running" == true ]]; then
        /usr/bin/open "$destination" 2>/dev/null || true
      fi
    else
      print -u2 "安装失败，旧版本保留在：$backup"
    fi
  fi
  /bin/rm -rf "$temporary_directory"
  return "$exit_status"
}
trap cleanup EXIT
/usr/bin/ditto "$source_app" "$temporary_directory/DingDong Selection.app"

if [[ -e "$destination" ]]; then
  running_pids=()
  while IFS= read -r process_line; do
    app_pid="${process_line%% *}"
    process_command="${process_line#* }"
    [[ "$process_command" == "$destination_binary" ]] && running_pids+=("$app_pid")
  done < <(/bin/ps -axo pid=,command= | /usr/bin/sed -E 's/^[[:space:]]+//')
  [[ ${#running_pids[@]} -gt 0 ]] && destination_was_running=true
  for app_pid in "${running_pids[@]}"; do
    current_command="$(/bin/ps -p "$app_pid" -o command= 2>/dev/null | /usr/bin/sed -E 's/^[[:space:]]+//')"
    if [[ -n "$app_pid" && "$current_command" == "$destination_binary" ]]; then
      /bin/kill "$app_pid"
    fi
  done
  for _ in {1..30}; do
    still_running=false
    for app_pid in "${running_pids[@]}"; do
      current_command="$(/bin/ps -p "$app_pid" -o command= 2>/dev/null | /usr/bin/sed -E 's/^[[:space:]]+//')"
      if [[ -n "$app_pid" && "$current_command" == "$destination_binary" ]]; then
        still_running=true
        break
      fi
    done
    [[ "$still_running" == false ]] && break
    /bin/sleep 0.1
  done
  [[ "$still_running" == false ]] || {
    print -u2 "正在运行的旧版本未能安全退出；安装已停止。"
    exit 1
  }
  backup="$destination.backup-$(/bin/date +%Y%m%d-%H%M%S)"
  /bin/mv "$destination" "$backup"
  print "旧版本已备份到：$backup"
fi

/bin/mv "$temporary_directory/DingDong Selection.app" "$destination"
/usr/bin/open "$destination"
install_succeeded=true
print "已安装并启动：$destination"
