import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'console_port.dart';
import 'fuli_runtime.dart';
import 'runtime_output.dart';
import 'tray_install.dart';

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
      _context = root == null ? null : parseControllerContext(await _run(root, 'context') ?? '');
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
  Future<RuntimeReport> previewRecovery({bool abandonImport = false, bool keepNewer = false}) =>
      _action('${recoveryAction(abandonImport: abandonImport, keepNewer: keepNewer)}-preview');

  // The controller recovers in its own process, after the confirmation here.
  @override
  bool get recoversInTerminal => false;

  @override
  Future<RuntimeReport> recoverAndStart(String digest, {bool abandonImport = false, bool keepNewer = false, StageListener? onStage}) =>
      _action('${recoveryAction(abandonImport: abandonImport, keepNewer: keepNewer)}-start', onStage: onStage, extra: [digest]);

  @override
  Future<RuntimeReport> endOrphansAndStart({StageListener? onStage}) => _action('end-orphans-start', onStage: onStage);

  Future<RuntimeReport> _action(String action, {StageListener? onStage, List<String> extra = const []}) async {
    if (!await locate()) return const RuntimeReport(RuntimeState.notFound);
    final output = await _run(_root!, action, onStage, extra);
    return output == null ? stillImporting() : parseControllerReply(output);
  }

  // detachedWithStdio keeps Windows from opening a console window for
  // node.exe under this GUI process; its exit code is not available, so the
  // controller's JSON `ok` field carries the outcome. Its lines are read as
  // they arrive: the steps it reports while it works, then the result. A tray
  // start can run first-time setup and then start the graph (the controller
  // bounds each CLI call at five minutes); an import goes on far longer
  // (readControllerLines). Null when the wait ran out during an import.
  Future<String?> _run(String root, String action, [StageListener? onStage, List<String> extra = const []]) async {
    try {
      final process = await Process.start(
        nodePathOf(root),
        [controllerPathOf(root), action, ...extra],
        workingDirectory: root,
        environment: onStage == null ? null : stageMarkersEnvironment,
        mode: ProcessStartMode.detachedWithStdio,
      );
      unawaited(process.stderr.drain<void>());
      final read = await readControllerLines(process.stdout, onStage);
      if (!read.timedOut) return read.output;
      if (read.importing) return null;
      return jsonEncode({'ok': false, 'status': 'unknown', 'error': 'The FULI tray controller did not answer.'});
    } on ProcessException catch (error) {
      return jsonEncode({'ok': false, 'status': 'unknown', 'error': error.message});
    }
  }
}
