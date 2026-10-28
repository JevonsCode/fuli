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
import 'desktop_window.dart';
import 'os_notifier.dart';
import 'system_tray.dart';

/// Composition root on Windows and macOS: wires the real HTTP API, FULI's
/// own start/stop entry points, the window, the tray and notifications.
Future<AppServices> createServices(Strings strings) async {
  final window = DesktopWindow();
  await window.open();
  const opener = BrowserUrlOpener();
  final client = http.Client();
  final controller = FuliController(
    apiFor: (port) => HttpFuliApi(port: port, client: client),
    runtime: _runtime(),
    notifier: await OsNotifier.create(onClick: window.show),
    strings: strings,
  );
  late final SystemTray tray;
  tray = SystemTray(
    strings: strings,
    onOpen: window.show,
    onOpenConsole: () => opener.open(controller.consoleUri),
    onToggle: () => controller.snapshot?.running == true ? controller.stop() : controller.start(),
    onQuit: () async {
      await tray.remove();
      await window.quit();
    },
  );
  void showTray() => tray.show(trayViewOf(controller.snapshot, busy: controller.pending != null, strings: strings));
  controller.addListener(showTray);
  showTray();
  window.onVisibilityChanged = controller.setVisible;
  controller.startPolling();
  return AppServices(controller: controller, strings: strings, opener: opener);
}

FuliRuntime _runtime() => Platform.isWindows
    ? WindowsTrayRuntime(exeDir: File(Platform.resolvedExecutable).parent.path, env: Platform.environment)
    : ShellCliRuntime(os: Platform.operatingSystem, env: Platform.environment);
