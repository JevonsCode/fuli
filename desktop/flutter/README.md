# FULI desktop client

A Windows and macOS app for people who do not use a terminal: one window and a tray (menu bar) icon.

- Whenever the console answers, the window is the console itself, in a WebView (WebView2 on Windows,
  WKWebView on macOS; `lib/src/platform/desktop/console_webview.dart`). Its own banner already shows the
  doctor's findings, repair, update and data-format confirmation. Only console pages load there; other
  links open in the default browser. WebView2 keeps its data in `%LOCALAPPDATA%\FULI Desktop\WebView2`,
  outside the versioned program folder. Without a WebView runtime the window keeps the status page
  below and its 「打开控制台」 opens the browser.
- The status page is shown while there is no console to show (not started, not installed, not
  answering): it says whether FULI works and fixes what it can with buttons. Full width, one column:
  a pinned frosted-glass top line (the FULI mark, a status dot and one sentence; the installed version
  in the dot's tooltip), one card per doctor item (one sentence, at most one button, details folded
  until the card is clicked), and a pinned bottom bar with 「打开控制台」 on the left and the one primary
  action (启动 / 停止 FULI, or the install page) on the right. What runs now, or the last outcome,
  shows between those two buttons, so neither moves. With nothing to say, the page stays empty.
- While FULI is checked for the first time, started or moved to another port, and until the console
  page has loaded in the WebView, the window shows the loading mark with what is really happening
  (「正在检查 FULI…」, 「正在启动 FULI…」, 「正在打开控制台…」), never a blank window or the stopped page.

- Reads `GET /api/system/doctor` from the local console at `http://127.0.0.1:<port>` and shows one
  sentence for FULI's state plus one card per item. On an older FULI without the doctor it falls back
  to `/api/health` and `/api/system/version`.
- 「自动修复」 calls `POST /api/system/doctor/repair`; 「查看并确认」 shows the `GET /api/data-format`
  preview and applies it with its digest; 「更新到 vX」 starts `POST /api/system/update` and follows
  its steps.
- Starts and stops FULI only through FULI's own entry points: the tray controller
  (`runtime\node\node.exe src\desktop\windows-controller.js start|stop|status|change-port|context`) on Windows;
  on macOS the controller inside the app (`Contents/Resources/fuli/runtime/node/bin/node
  src/desktop/macos-controller.js start|stop|status`, `macos_app_runtime.dart`), or, for a client
  built without FULI inside, `fuli start|stop|status --json` through the login shell.
- The console port is `ports.console` in the data directory's `runtime-settings.json` (default 2727).
- `fuli://` links (`lib/src/platform/fuli_link.dart`) only navigate, so they keep working when the
  port changes or a chat app drops `http://127.0.0.1` links: `fuli://status` (or `fuli://`) shows
  this window; `fuli://<path>?<query>` opens `http://127.0.0.1:<console port>/<path>?<query>` in the
  browser. Only plain console paths pass: no other host, port, user info or fragment, no `.`/`..`
  segments or encoded slashes, printable ASCII only (percent-encode the rest), at most 2048
  characters. Anything else is ignored. A start for a console link keeps the window hidden.
- 「导出诊断包…」 in the tray menu follows `fuli://settings?tab=system&setting=diagnostics`: the
  settings page's 诊断包 card, where the person previews the redacted bundle and exports it.
- Checks every 15 s while the window is visible and every 120 s while hidden, backing off when the
  console does not answer. One OS notification when FULI gets worse; closing the window hides it.

## On Windows

It is the tray app of the Windows package (`docs/windows-first-install.md`, 「Desktop client」):
`client\FULI.exe` beside the package, started by the package root's `Fuli.exe` launcher.

- One client per user and data directory (`lib/src/platform/desktop/windows_instance.dart`): a
  second launch shows the running client's window; an update's exit signal closes it once a
  running start, stop or port change has finished.
- `--background` starts it with the tray icon only; the window stays hidden until the client
  shows it (`windows/runner/flutter_window.cpp`).
- `fuli://` is registered for the current user by an installed client
  (`windows_url_scheme.dart`: `HKCU\Software\Classes\fuli`, opening `"<package>\Fuli.exe" "%1"`);
  updates, rollbacks and uninstall follow or remove it (`src/desktop/windows-desktop-client.js`).
  The launcher passes the link on. A launch with a link leaves it in
  `%LOCALAPPDATA%\FULI Desktop\links\<instanceKey>\` (`link_inbox.dart`, one file per link, written
  then renamed) and only then signals the running client, which takes every waiting link: the
  shared `-open` event carries no payload, so older versions and updates keep the same names, and
  coalesced signals lose no link. A starting client takes links left while none ran (an update held
  the lock); links older than five minutes are dropped.
- Launch at login is on for an installed FULI until 「开机时启动」 in the tray menu turns it off
  (`windows_login_launch.dart`). The tray menu also has 「换一个端口」.
- Notifications use an app identity registered under the current user, not a Start-menu shortcut.

## On macOS

It ships as FULI.app in a .dmg with FULI, Node, Java 21, Neo4j and the Provider's Python inside
(`docs/macos-app.md`, built by `scripts/build-macos-app.js`): drag it to Applications and open it.
The first 「启动 FULI」 sets FULI up in native mode; data stays in `~/Library/Application Support/Fuli`.

`fuli` is declared in `macos/Runner/Info.plist` (`CFBundleURLTypes`); macOS registers it when the
app is installed and hands links to the running app, received through `app_links`.

## Layout

- `lib/src/api` HTTP API (`FuliApi`), `lib/src/doctor` the doctor report, `lib/src/runtime` start/stop
  and port (`FuliRuntime`), `lib/src/app` state (`FuliController`), `lib/src/ui` the window,
  `lib/src/platform` tray, window and notifications behind small ports, `lib/src/l10n` Chinese and English text.
- `lib/src/preview` a synthetic FULI used by the web preview and the widget tests.
- `assets/brand/fuli-mark.json` the FULI mark (master and micro geometry as SVG path data on a
  512 x 512 view box, the black-gold stops and the logo ink), generated from the brand's mark SVGs.
  `lib/src/ui/brand.dart` reads it before the first frame; `fuli_mark.dart` paints it (the micro
  geometry below 28 px) and `loading_mark.dart` animates it as the brand's loading
  (`motion/fuli-motion.css`), still under reduced motion. `GrowthLoading` is the one pending
  indicator, as in the console. The tests read the same contract from `test/fixtures/fuli-mark.json`.
- `assets/tray` the three tray icons, `assets/app` and the Windows and macOS app icons: the FULI logo
  (`brand/fuli-logo.png`) with a green, amber or red status dot on the tray ones, generated by
  `node scripts/build-brand-assets.js` from the repository root (`brand/README.md`).

## Tests

```
flutter pub get
flutter analyze
flutter test
```

Tests use synthetic data, temporary directories and mock HTTP clients only. To look at the window
without FULI, `flutter build web` and serve `build/web`; `?state=ok|needs|degraded|stopped|notfound|old`
picks a scenario; a start there takes three seconds, so the waiting screen shows.

## Builds

`.github/workflows/desktop-client.yml` runs analyze and tests, then `flutter build windows --release`
on `windows-latest` and `flutter build macos --release` on `macos-latest` for changes under
`desktop/flutter/`. The builds are unsigned workflow artifacts (`fuli-desktop-windows`,
`fuli-desktop-macos`), not release assets. Releases ship the Windows build inside the tray package
(`.github/actions/windows-tray`); the same workflow builds that package for pull requests that touch
the desktop code (`fuli-windows-tray`). It also builds the macOS .dmg (`.github/actions/macos-app`,
artifact `fuli-macos-dmg`) and smoke-tests it: mount, copy FULI.app out, start FULI from it with a
temporary HOME and no Node, Java or Python on PATH, stop it, launch the client. Unsigned unless the
Developer ID secrets exist (`docs/macos-app.md`, 「Signing」); not a release asset yet.
