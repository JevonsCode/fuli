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
`--background` or one `fuli://` link (printable ASCII, no quotes, backslashes or
spaces, at most 2048 characters), which it passes to the client. The retired
FuliTray.exe is no longer built.

- One client per Windows user and data directory. It holds the mutex
  `Global\FuliTray-<user SID>-<instanceKey>` (`instanceKey` from
  `windows-controller.js context`), the same name the old tray used, so updates and
  older versions on either side find each other. A second launch sets
  `<name>-open` (the running client shows its window) and exits. A launch with a
  `fuli://` link first leaves it as one file in
  `%LOCALAPPDATA%\FULI Desktop\links\<instanceKey>\`; the running client takes every
  waiting link when signalled, and a starting client takes those left while none ran.
  Links older than five minutes are dropped.
- Updates set `<name>-exit`; the client finishes a running start, stop or port change,
  then exits. `Update-Fuli.cmd`, `Rollback-Fuli.cmd` and the console's one-click
  update close a running client first and open the installed version's client
  afterwards; `Uninstall-Fuli.cmd` closes it and does not reopen it.
- Launch at login is on for an installed client until the person turns off
  「开机时启动」 in the tray menu (`HKCU\Software\Fuli\DesktopClient\LaunchAtLogin`).
  The entry is `HKCU\...\CurrentVersion\Run\FULI` =
  `"<package>\Fuli.exe" --background` (tray icon only). Each start of the installed client points it
  at its own version; an update or rollback points an existing entry at the version
  it installs, or removes it when that version has no desktop client (the old tray
  takes no arguments). Uninstall removes the entry, the client settings key, the
  notification identity `HKCU\Software\Classes\AppUserModelId\FULI` and the Installed
  apps entry FULI-Setup.exe registers when it names this installation.
- `fuli://` links open the installed client: `HKCU\Software\Classes\fuli` (`URL Protocol`)
  with `shell\open\command` = `"<package>\Fuli.exe" "%1"`. Each start of the installed client
  points it at its own version; updates and rollbacks follow it like the launch-at-login
  entry, and uninstall removes the key when it opens this installation. A rollback to a
  version whose client predates `fuli://` keeps the key on that launcher, which refuses
  the link with its message until a newer client registers again.
- Windows notifications use the identity `HKCU\Software\Classes\AppUserModelId\FULI`
  (`DisplayName` FULI, `IconUri` the installed client's `fuli.png`), which each start of
  the installed client writes where it is missing or differs. Never a Start-menu shortcut:
  stamping one into `Fuli.lnk` would change the installer's shortcut, and updates
  refuse a changed shortcut.
- "The installed client" is a release build that is the version `installation.json` names
  now. A debug or profile build (`flutter run`), a client build folder, a package that was
  never installed and an older version kept for rollback do not write these per-user
  entries at all: there is one of each per user, shared by every FULI build on the machine.
- The tray menu keeps the old tray's 「换一个端口」 (`windows-controller.js
  change-port`); a start that fails on a port Windows reserves says to use it.
- Icons come from the FULI mark in `brand/` with a green, amber or red status dot:
  `node scripts/build-brand-assets.js` (`brand/README.md`).

## One-click installation (FULI-Setup.exe)

For people who do not use a terminal, each release attaches `FULI-Setup-<version>.exe`
next to the tray zip: download it, double-click it, click 「安装 / Install」, and FULI
opens. The setup carries the same verified tray directory as the zip, so Node, Java
and the graph database come with it and nothing else needs installing.

- Per user, no administrator permission. The wizard is in Chinese or English,
  following the Windows display language.
- It extracts the tray directory to its temporary folder, runs the bundled
  `runtime\node\node.exe src\desktop\windows-install.js --yes` without a console
  window, deletes the temporary copy, and offers 「启动 FULI / Launch FULI」 (checked),
  which opens the installed `<package>\Fuli.exe`. Locations and shortcuts are the
  defaults below; nothing is asked.
- Data a previous FULI left in `%LOCALAPPDATA%\Fuli` (an uninstall keeps it) is
  adopted unchanged (`--adopt-existing-data`); a folder there that is not FULI data
  is refused.
- When FULI is already installed under `%LOCALAPPDATA%\Programs\Fuli`, it runs the
  package's `src\desktop\windows-update-command.js --yes` instead, the same update as
  `Update-Fuli.cmd`: data is kept, the running desktop client closes and reopens. The
  same version is left as it is. A lower version is refused (no `--allow-downgrade`).
- If that step fails, the last page shows its error text and the setup log path
  (`%TEMP%\Setup Log <date> #<n>.txt`, which also has the full node output), the
  launch option is hidden and the setup exits with code 1.
- It registers FULI in Windows' Installed apps (`HKCU\...\CurrentVersion\Uninstall\FULI`,
  no uninstaller of its own). Its uninstall runs `Uninstall-Fuli`'s script through the
  root `FuliNode.exe`, so it follows updates; `Uninstall-Fuli.cmd` removes the entry.
- The setup is not code-signed yet. Windows SmartScreen warns about it 「Windows 已保护你的电脑 /
  Windows protected your PC」; choose 「更多信息 / More info」 and then 「仍要运行 / Run anyway」.
  Compare the download with its `.sha256` asset to check it.

It is built by `scripts/build-windows-setup.js --tray <tray> --output <folder>` with
Inno Setup 6.3 or later (`ISCC.exe`, `--iscc` to name it) from
`desktop/windows-setup/fuli-setup.iss`; the version is the tray's `package.json`.
`.github/actions/windows-tray` builds it with the zip, installing Inno Setup with
Chocolatey when the runner lacks it, and the Desktop client workflow installs it
silently on the runner as a check.

## Installation

Run `Install-Fuli.cmd` in the resulting directory and confirm its displayed paths
(the one-click setup above runs the same installer).
No administrator permission is requested. Defaults:

- Application: `%LOCALAPPDATA%\Programs\Fuli\versions\<installation-id>`.
- Client-configuration launcher: `%LOCALAPPDATA%\Programs\Fuli\FuliNode.exe` (see below).
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

## Client configurations

Agent client configurations of an installed copy (MCP entries, Claude Code, Codex
and Cursor hooks, the OpenCode plugin file) never name a version folder (rec#11
D-80). They run `FuliNode.exe` at the installation root with a script relative to
the package:

```
"%LOCALAPPDATA%\Programs\Fuli\FuliNode.exe" src\mcp-server.js --runtime-config ...
```

`FuliNode.exe` (`desktop/windows/FuliNodeLauncher.cs`, a console program) reads
`installation.json` beside it at every launch and runs that version's
`runtime\node\node.exe` with the script inside that version. Arguments, working
directory, environment, standard input/output/error and the exit code pass through
unchanged, so stdio MCP and lifecycle hooks behave as if node had been started
directly; node runs in a job that ends with the launcher (a hook timeout that kills
the launcher ends node too). It refuses an absolute script, one outside the package,
and a record naming a folder outside `versions\`. Without an `installation.json`
beside it (a package or slot copy), it runs its own folder.

Install, update and rollback copy the launcher of the version they install to the
root before anything stops; a launcher a client is still running is renamed aside
and removed once it is free. Any version's launcher runs any version's
`installation.json`, so a rollback to a version from before the launcher keeps the
installed one. Uninstall removes it (after the clients still running it exit).
Setup in an installed copy writes this form only when the launcher is present;
npm installs and uninstalled packages keep this Node and absolute paths. Clients
connected with absolute version paths are reported outdated (`client_outdated`) and
are migrated by the next `setup --connected-only`, update or 体检 repair; after that
an update or rollback leaves client configurations unchanged. The OpenCode plugin
file imports `plugin.js` from the version `installation.json` names when OpenCode
loads it. Clients FULI does not manage, such as a hand-written configuration, can
use the same command (`fuli connect` prints it).
