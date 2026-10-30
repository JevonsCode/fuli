import 'dart:io';

import 'package:http/http.dart' as http;

import '../../api/http_fuli_api.dart';
import '../../app/app_services.dart';
import '../../app/fuli_controller.dart';
import '../../app/tray_view.dart';
import '../../l10n/strings.dart';
import '../../runtime/fuli_runtime.dart';
import '../../runtime/shell_cli_runtime.dart';
import '../../runtime/windows_tray_runtime.dart';
import '../url_opener.dart';
import 'console_webview.dart';
import 'desktop_window.dart';
import 'os_notifier.dart';
import 'system_tray.dart';
import 'windows_instance.dart';
import 'windows_login_launch.dart';

/// Composition root on Windows and macOS: wires the real HTTP API, FULI's
/// own start/stop entry points, the window, the tray and notifications.
/// `--background` (Windows launch at login) starts with the tray icon only.
Future<AppServices> createServices(Strings strings, List<String> args) async {
  final background = args.contains('--background');
  final exeDir = File(Platform.resolvedExecutable).parent.path;
  final runtime = _runtime(exeDir);
  final instance = runtime is WindowsTrayRuntime ? await _claimInstance(runtime, handOver: !background) : null;
  final window = DesktopWindow();
  await window.open(show: !background);
  const opener = BrowserUrlOpener();
  final console = await ConsoleWebView.create(opener);
  final client = http.Client();
  final controller = FuliController(
    apiFor: (port) => HttpFuliApi(port: port, client: client),
    runtime: runtime,
    notifier: await OsNotifier.create(
        onClick: window.show, windowsIcon: '$exeDir\\data\\flutter_assets\\assets\\app\\fuli.png'),
    strings: strings,
  );
  final loginLaunch = Platform.isWindows ? WindowsLoginLaunch.forClient(exeDir) : null;
  bool? launchAtLogin = await _choice(loginLaunch?.apply());
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

  tray = SystemTray(
    strings: strings,
    onOpen: window.show,
    onToggle: () => controller.snapshot?.running == true ? controller.stop() : controller.start(),
    onQuit: quit,
    onChangePort: runtime.canChangePort ? controller.changePort : null,
    onLaunchAtLogin: loginLaunch == null
        ? null
        : (on) async {
            launchAtLogin = await _choice(loginLaunch.setEnabled(on)) ?? launchAtLogin;
            showTray();
          },
  );
  controller.addListener(showTray);
  showTray();
  window.onVisibilityChanged = controller.setVisible;
  if (background) controller.setVisible(false);
  // An update closes the client once a start, stop or port change it runs has finished.
  instance?.listen(onOpen: window.show, onExit: () async {
    await controller.runtimeIdle();
    await quit();
  });
  controller.startPolling();
  return AppServices(controller: controller, strings: strings, opener: opener, consoleView: console?.build);
}

FuliRuntime _runtime(String exeDir) => Platform.isWindows
    ? WindowsTrayRuntime(exeDir: exeDir, env: Platform.environment)
    : ShellCliRuntime(os: Platform.operatingSystem, env: Platform.environment);

// One client per installation's data directory. A second launch shows the
// running client's window and exits; without an installation there is
// nothing to share and no lock.
Future<WindowsInstance?> _claimInstance(WindowsTrayRuntime runtime, {required bool handOver}) async {
  final context = await runtime.context();
  if (context == null) return null;
  final (claim, instance) = WindowsInstance.claim(context.instanceKey, handOver: handOver);
  if (claim != InstanceClaim.owner) exit(0);
  return instance;
}

// The registry may refuse; the menu entry then stays as it was.
Future<bool?> _choice(Future<bool>? pending) async {
  try {
    return await pending;
  } on ProcessException {
    return null;
  }
}
