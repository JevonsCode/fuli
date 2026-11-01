import 'dart:async';
import 'dart:io';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../../api/http_fuli_api.dart';
import '../../app/app_services.dart';
import '../../app/fuli_controller.dart';
import '../../app/tray_view.dart';
import '../../l10n/strings.dart';
import '../../runtime/fuli_runtime.dart';
import '../../runtime/macos_app_runtime.dart';
import '../../runtime/shell_cli_runtime.dart';
import '../../runtime/windows_tray_runtime.dart';
import '../fuli_link.dart';
import '../url_opener.dart';
import 'console_webview.dart';
import 'desktop_caption.dart';
import 'desktop_window.dart';
import 'download_saver.dart';
import 'installed_package.dart';
import 'link_inbox.dart';
import 'os_notifier.dart';
import 'system_tray.dart';
import 'windows_instance.dart';
import 'windows_login_launch.dart';
import 'windows_notification_identity.dart';
import 'windows_url_scheme.dart';

/// Composition root on Windows and macOS: wires the real HTTP API, FULI's
/// own start/stop entry points, the window, the tray and notifications.
/// `--background` (Windows launch at login) starts with the tray icon only.
/// A `fuli://` link (on Windows the launcher passes it) is followed once the
/// client runs; the window opens only when the link asks for it.
Future<AppServices> createServices(Strings strings, List<String> args) async {
  final background = args.contains('--background');
  final link = args.map(FuliLink.parse).nonNulls.firstOrNull;
  final quiet = background || link?.opensClient == false;
  final exeDir = File(Platform.resolvedExecutable).parent.path;
  final runtime = _runtime(exeDir);
  final claimed = runtime is WindowsTrayRuntime ? await _claimInstance(runtime, handOver: !background, link: link) : null;
  final (instance, inbox) = (claimed?.instance, claimed?.inbox);
  final window = DesktopWindow();
  await window.open(title: strings.appName, show: !quiet);
  final caption = await DesktopCaption.create();
  const opener = BrowserUrlOpener();
  final packageRoot = await _registeringPackage(exeDir);
  if (packageRoot != null) await _registry(WindowsNotificationIdentity(packageRoot: packageRoot).apply());
  final notifier = await OsNotifier.create(onClick: window.show);
  final client = http.Client();
  final controller = FuliController(
    apiFor: (port) => HttpFuliApi(port: port, client: client),
    runtime: runtime,
    notifier: notifier,
    strings: strings,
  );
  final loginLaunch = packageRoot == null ? null : WindowsLoginLaunch(packageRoot: packageRoot);
  bool? launchAtLogin = await _registry(loginLaunch?.apply());
  if (packageRoot != null) unawaited(_registry(WindowsUrlScheme(packageRoot: packageRoot).apply()));
  late final SystemTray tray;
  void showTray() => tray.show(trayViewOf(controller.snapshot,
      busy: controller.pending != null,
      strings: strings,
      canChangePort: runtime.canChangePort,
      launchAtLogin: launchAtLogin));
  Future<void> quit() async {
    await tray.remove();
    instance?.release();
    await window.quit();
  }

  // The tray menu and the console's first-run guide change the same setting.
  Future<bool?> changeLaunchAtLogin(bool on) async {
    launchAtLogin = await _registry(loginLaunch!.setEnabled(on)) ?? launchAtLogin;
    showTray();
    return launchAtLogin;
  }

  // A fuli:// link only navigates: to this window, or to a console page in the browser.
  Future<void> follow(FuliLink link) async =>
      link.opensClient ? window.show() : opener.open(link.consolePage(await controller.consolePort()));

  tray = SystemTray(
    strings: strings,
    onOpen: window.show,
    onToggle: () => controller.snapshot?.running == true ? controller.stop() : controller.start(),
    onExportDiagnostics: () => unawaited(follow(FuliLink.parse(diagnosticsLink)!)),
    onQuit: quit,
    onChangePort: runtime.canChangePort ? controller.changePort : null,
    onLaunchAtLogin: loginLaunch == null ? null : (on) => unawaited(changeLaunchAtLogin(on)),
  );
  controller.addListener(showTray);
  showTray();
  final console = await ConsoleWebView.create(opener,
      saver: DownloadSaver(),
      onSaved: (file) => unawaited(notifier.notify(strings.fileSaved, file.path)),
      caption: caption,
      launchAtLogin: loginLaunch == null ? null : (read: () => launchAtLogin, change: changeLaunchAtLogin));
  window.onVisibilityChanged = controller.setVisible;
  if (quiet) controller.setVisible(false);
  // A second launch asks for the window or leaves its link in the inbox.
  // An update closes the client once a start, stop or port change it runs has finished.
  instance?.listen(onOpen: () {
    final links = inbox?.take() ?? const <FuliLink>[];
    if (links.isEmpty) unawaited(window.show());
    for (final link in links) {
      unawaited(follow(link));
    }
  }, onExit: () async {
    await controller.runtimeIdle();
    await quit();
  });
  // This launch's own link, and any left while no client ran (an update held the lock).
  for (final link in [...?inbox?.take(), if (claimed?.linkLeft != true) ?link]) {
    unawaited(follow(link));
  }
  // macOS hands links to the running app; the stream starts with the one that launched it.
  if (Platform.isMacOS) {
    AppLinks().stringLinkStream.map(FuliLink.parse).listen((link) {
      if (link != null) unawaited(follow(link));
    });
  }
  controller.startPolling();
  return AppServices(
      controller: controller, strings: strings, opener: opener, consoleView: console?.build, caption: caption);
}

// Windows: the tray package's controller. macOS: the FULI inside this app
// when it was built with one (the .dmg), otherwise the `fuli` CLI.
FuliRuntime _runtime(String exeDir) {
  if (Platform.isWindows) return WindowsTrayRuntime(exeDir: exeDir, env: Platform.environment);
  final bundled = Platform.isMacOS ? bundledFuliRoot(exeDir) : null;
  return bundled != null
      ? MacosAppRuntime(root: bundled, env: Platform.environment)
      : ShellCliRuntime(os: Platform.operatingSystem, env: Platform.environment);
}

// One client per installation's data directory. A launch leaves its link in
// the inbox first: a second launch then signals the running client and
// exits, the first one takes it back. Without an installation there is
// nothing to share and no lock.
Future<({WindowsInstance instance, LinkInbox? inbox, bool linkLeft})?> _claimInstance(WindowsTrayRuntime runtime,
    {required bool handOver, FuliLink? link}) async {
  final context = await runtime.context();
  if (context == null) return null;
  final inbox = LinkInbox.forInstance(context.instanceKey, Platform.environment);
  var linkLeft = false;
  if (link != null && inbox != null) {
    try {
      inbox.put(link);
      linkLeft = true;
    } on FileSystemException {
      // A second launch then only shows the running client's window.
    }
  }
  final (claim, instance) = WindowsInstance.claim(context.instanceKey, handOver: handOver);
  if (claim != InstanceClaim.owner) exit(0);
  return (instance: instance!, inbox: inbox, linkLeft: linkLeft);
}

// The package that registers itself with Windows, or null: on macOS, for a
// debug or profile build (flutter run), and for a release build that is not
// the current version of an installation (a build folder, a package copy, a
// version kept for rollback). The entries are one per user and shared by every
// FULI build on the machine, so only the installed version may write them.
Future<String?> _registeringPackage(String exeDir) async =>
    Platform.isWindows && kReleaseMode ? installedPackageRoot(exeDir) : null;

// reg.exe may not run: the menu entry and the registrations stay as they
// were, and the next start tries again.
Future<T?> _registry<T>(Future<T>? pending) async {
  try {
    return await pending;
  } on ProcessException {
    return null;
  }
}
