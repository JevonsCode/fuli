import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'console_port.dart';
import 'fuli_runtime.dart';
import 'runtime_output.dart';
import 'tray_install.dart';

// A tray start can run first-time setup and then start the graph; the
// controller itself bounds each CLI call at five minutes.
const _controllerTimeout = Duration(minutes: 10);

/// Runs the tray's controller (`node.exe windows-controller.js <action>`) of
/// the installation this client ships in, and reads its one-line JSON answer.
class WindowsTrayRuntime implements FuliRuntime {
  WindowsTrayRuntime({required this.exeDir, required this.env});

  final String exeDir;
  final Map<String, String> env;
  String? _root;
  ControllerContext? _context;

  /// The installation's data directory and lock key; null without one.
  Future<ControllerContext?> context() async => await locate() ? _context : null;

  @override
  Future<bool> locate() async {
    final root = await locateTrayInstall(exeDir: exeDir, env: env);
    if (root != _root) {
      _root = root;
      // The installation names its data directory; ask once per installation.
      _context = root == null ? null : parseControllerContext(await _run(root, 'context'));
    }
    return root != null;
  }

  @override
  Future<int> consolePort() => readConsolePort(_context?.dataDir ?? defaultDataDir(os: 'windows', env: env));

  // The installation names its log folder (windows-controller.js `context`).
  @override
  Future<String> logDirectory() async =>
      (await context())?.logDir ?? '${defaultDataDir(os: 'windows', env: env)}\\logs';

  @override
  Future<RuntimeReport> status() => _action('status');

  @override
  Future<RuntimeReport> start({StageListener? onStage}) => _action('start', onStage: onStage);

  @override
  Future<RuntimeReport> stop() => _action('stop');

  @override
  bool get canChangePort => true;

  @override
  Future<RuntimeReport> changePort({StageListener? onStage}) => _action('change-port', onStage: onStage);

  @override
  Future<RuntimeReport> releaseLockAndStart({StageListener? onStage}) => _action('release-lock-start', onStage: onStage);

  @override
  Future<RuntimeReport> previewRecovery({bool abandonImport = false}) =>
      _action(abandonImport ? 'abandon-import-preview' : 'recover-preview');

  // The controller recovers in its own process, after the confirmation here.
  @override
  bool get recoversInTerminal => false;

  @override
  Future<RuntimeReport> recoverAndStart(String digest, {bool abandonImport = false, StageListener? onStage}) =>
      _action(abandonImport ? 'abandon-import-start' : 'recover-start', onStage: onStage, extra: [digest]);

  Future<RuntimeReport> _action(String action, {StageListener? onStage, List<String> extra = const []}) async {
    if (!await locate()) return const RuntimeReport(RuntimeState.notFound);
    return parseControllerReply(await _run(_root!, action, onStage, extra));
  }

  // detachedWithStdio keeps Windows from opening a console window for
  // node.exe under this GUI process; its exit code is not available, so the
  // controller's JSON `ok` field carries the outcome. Its lines are read as
  // they arrive: the steps it reports while it works, then the result.
  Future<String> _run(String root, String action, [StageListener? onStage, List<String> extra = const []]) async {
    try {
      final process = await Process.start(
        nodePathOf(root),
        [controllerPathOf(root), action, ...extra],
        workingDirectory: root,
        environment: onStage == null ? null : stageMarkersEnvironment,
        mode: ProcessStartMode.detachedWithStdio,
      );
      unawaited(process.stderr.drain<void>());
      final output = StringBuffer();
      await process.stdout.transform(utf8.decoder).transform(const LineSplitter()).forEach((line) {
        output.writeln(line);
        if (parseStageLine(line) case final step?) onStage?.call(step.stage, step.maxSeconds);
      }).timeout(_controllerTimeout);
      return output.toString();
    } on ProcessException catch (error) {
      return jsonEncode({'ok': false, 'status': 'unknown', 'error': error.message});
    } on TimeoutException {
      return jsonEncode({'ok': false, 'status': 'unknown', 'error': 'The FULI tray controller did not answer.'});
    }
  }
}
