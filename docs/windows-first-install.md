# Windows per-user first installation

This slice installs a complete checksum-verified tray directory for the current
user. Build with `scripts/build-windows-tray.js`, reusing either a portable or tray
asset bundle with the identical shrinkwrap. Keep `--output` to 80 characters or
fewer (for example `T:\fb\tray`); a longer root leaves no room for the bundled
Python files under Windows' 260-character limit. The builder still refreshes
application, management page and embedded Provider source from the checkout.
`--client` names the Release folder of the desktop client
(`desktop/flutter`, `flutter build windows --release`, i.e.
`desktop\flutter\build\windows\x64\runner\Release`); without the Visual Studio C++
tools, download the `fuli-desktop-windows` artifact of the Desktop client workflow
instead. CI builds the same package with `.github/actions/windows-tray`, for releases
and for pull requests that touch the desktop code (artifact `fuli-windows-tray`).

## Desktop client

The package's tray app is the FULI desktop client: `client\FULI.exe` with its engine,
plugin DLLs and `data\` folder, started by `Fuli.exe` at the package root. The
launcher stays at the root because shortcuts, the launch-at-login entry and older
versions' one-click updates open `<package>\Fuli.exe`; it accepts only
`--background`. The retired FuliTray.exe is no longer built.

- One client per Windows user and data directory. It holds the mutex
  `Global\FuliTray-<user SID>-<instanceKey>` (`instanceKey` from
  `windows-controller.js context`), the same name the old tray used, so updates and
  older versions on either side find each other. A second launch sets
  `<name>-open` (the running client shows its window) and exits.
- Updates set `<name>-exit`; the client finishes a running start, stop or port change,
  then exits. `Update-Fuli.cmd`, `Rollback-Fuli.cmd` and the console's one-click
  update close a running client first and open the installed version's client
  afterwards; `Uninstall-Fuli.cmd` closes it and does not reopen it.
- Launch at login is on for an installed client until the person turns off
  「开机时启动」 in the tray menu (`HKCU\Software\Fuli\DesktopClient\LaunchAtLogin`).
  The entry is `HKCU\...\CurrentVersion\Run\FULI` =
  `"<package>\Fuli.exe" --background` (tray icon only). Each client start points it
  at its own version; an update or rollback points an existing entry at the version
  it installs, or removes it when that version has no desktop client (the old tray
  takes no arguments). Uninstall removes the entry, the client settings key and the
  notification identity `HKCU\Software\Classes\AppUserModelId\FULI`.
- Windows notifications use that registered identity, never a Start-menu shortcut:
  stamping one into `Fuli.lnk` would change the installer's shortcut, and updates
  refuse a changed shortcut.
- The tray menu keeps the old tray's 「换一个端口」 (`windows-controller.js
  change-port`); a start that fails on a port Windows reserves says to use it.
- Icons come from `site/assets/fuli-logo.png` with a green, amber or red status dot:
  `dart run tool/make_icons.dart` in `desktop/flutter`.

## Installation

Run `Install-Fuli.cmd` in the resulting directory and confirm its displayed paths.
No administrator permission is requested. Defaults:

- Application: `%LOCALAPPDATA%\Programs\Fuli\versions\<installation-id>`.
- Data: `%LOCALAPPDATA%\Fuli`, created only by an explicit first start from the desktop client.
- Shortcuts: current user's Windows Desktop and Start menu Programs folders.

`planFirstWindowsInstall(options)` performs a read-only validation and preview.
`installWindowsForCurrentUser(options)` claims a new installation directory, copies
only verified inventory files and publishes new shortcuts without overwriting.
Options are `source`, optional absolute `installRoot`/`dataDir`, and optional
`shortcutDirectories: { desktop, startMenu }`. The bundled installer CLI exposes
`--install-root`, `--data-dir`, `--desktop-dir`, `--start-menu-dir` and `--yes`, so
acceptance can use isolated temporary paths. Neither entry starts services,
configures clients nor modifies PATH; launch at login is the desktop client's own
(see above).

`installation.json` outside the version slot and `installed-context.json` inside
must agree on installation ID, absolute package/data paths and inventory digest.
The actual package must occupy the recorded slot. Changing the candidate kind or
moving a copied installed directory does not grant access to default data. The
original candidate data guard remains active for uninstalled bundles. Installed
tray and CLI defaults use the registered external data; explicit CLI `--data-dir`
remains available. The native runtime builds its manifest from the installed
bundle on the first explicit setup; no old absolute runtime manifest is copied.

Any existing application directory or same-named shortcut is refused. An existing
data directory is refused unless `--adopt-existing-data` is given; then it must be
Fuli data (`runtime-settings.json` or `graph-runtime.json`) and is bound to the new
installation without any file in it being changed. The preview shows its current
graph runtime. Data that still uses Docker containers is not started by the tray,
which names the move instead:

```
"<package>\runtime\node\node.exe" "<package>\src\cli.js" graph migrate --to native
```

The move stops the running console, counts the container graph (labels and
relationship types) with no writer running, exports it under
`backups\graph\container-to-native-<time>`, sets up native mode, imports, and
accepts the result only when the native census is identical. On any failure it
switches back to container mode. The container volume is only read and is left
stopped; client integrations are not changed (run `setup --connected-only` from
the installed CLI afterwards to point clients at it). Updates run from a new
package's `Update-Fuli.cmd` or the console's one-click update; `Rollback-Fuli.cmd`
and `Uninstall-Fuli.cmd` ship in the installed slot (see `TRAY.md`). An update may
move Neo4j up a patch in the same major.minor after a graph backup and then refuses
to roll back below it; a downgrade or a major/minor change is refused. Installed
`fuli update` fails before npm access or stopping services. Do not manually move
installed slots.

On a caught first-install failure, cleanup removes only files still matching the
identities created by that attempt, then removes its empty directories. Replaced
shortcuts and unrelated files are preserved. No installed record is published
until both shortcuts succeed. A process crash can leave an incomplete directory;
rerunning refuses it instead of adopting or deleting it. Retain it for inspection
or move it aside manually before retrying. Data is never removed. The desktop
client's 「退出」 leaves Fuli running; 「停止 FULI」 requires the runtime to confirm a
stopped state.
