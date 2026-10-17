# Windows per-user first installation

This slice installs a complete checksum-verified tray directory for the current
user. Build with `scripts/build-windows-tray.js`, reusing either a portable or tray
asset bundle with the identical shrinkwrap. The builder still refreshes application,
management page and embedded Provider source from the checkout.

Run `Install-Fuli.cmd` in the resulting directory and confirm its displayed paths.
No administrator permission is requested. Defaults:

- Application: `%LOCALAPPDATA%\Programs\Fuli\versions\<installation-id>`.
- Data: `%LOCALAPPDATA%\Fuli`, created only by an explicit first tray start.
- Shortcuts: current user's Windows Desktop and Start menu Programs folders.

`planFirstWindowsInstall(options)` performs a read-only validation and preview.
`installWindowsForCurrentUser(options)` claims a new installation directory, copies
only verified inventory files and publishes new shortcuts without overwriting.
Options are `source`, optional absolute `installRoot`/`dataDir`, and optional
`shortcutDirectories: { desktop, startMenu }`. The bundled installer CLI exposes
`--install-root`, `--data-dir`, `--desktop-dir`, `--start-menu-dir` and `--yes`, so
acceptance can use isolated temporary paths. Neither entry starts services,
configures clients, modifies PATH nor enables login startup.

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
the installed CLI afterwards to point clients at it). Updates, uninstall and update
rollback are **not implemented**. Installed `fuli update` fails before
npm access or stopping services. A later update slice must verify stopped owned
processes, preserve data/configuration, rebind native asset paths and implement
rollback before replacing an installation. Do not manually move installed slots.

On a caught first-install failure, cleanup removes only files still matching the
identities created by that attempt, then removes its empty directories. Replaced
shortcuts and unrelated files are preserved. No installed record is published
until both shortcuts succeed. A process crash can leave an incomplete directory;
rerunning refuses it instead of adopting or deleting it. Retain it for inspection
or move it aside manually before retrying. Data is never removed. The existing
tray's exit-only action continues to leave Fuli running; its stop-and-exit action
requires the runtime to confirm a stopped state.
