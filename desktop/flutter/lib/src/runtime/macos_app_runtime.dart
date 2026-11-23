import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'console_port.dart';
import 'fuli_runtime.dart';
import 'runtime_output.dart';

// A first start sets FULI up and starts the graph; the controller bounds
// each CLI call at five minutes.
const _controllerTimeout = Duration(minutes: 10);

/// FULI shipped inside this app (scripts/build-macos-app.js):
/// `FULI.app/Contents/Resources/fuli`, with its own Node. Null for a client
/// built on its own, which then uses the `fuli` CLI (ShellCliRuntime).
String? bundledFuliRoot(String exeDir) {
  // exeDir is FULI.app/Contents/MacOS.
  final root = [Directory(exeDir).parent.path, 'Resources', 'fuli'].join('/');
  return File(macosNodePathOf(root)).existsSync() && File(macosControllerPathOf(root)).existsSync() ? root : null;
}

String macosNodePathOf(String root) => '$root/runtime/node/bin/node';

String macosControllerPathOf(String root) => '$root/src/desktop/macos-controller.js';

/// Runs the bundled controller (`node src/desktop/macos-controller.js ACTION`)
/// and reads its one-line JSON answer, as on Windows.
class MacosAppRuntime implements FuliRuntime {
  MacosAppRuntime({required this.root, required this.env});

  final String root;
  final Map<String, String> env;

  @override
  Future<bool> locate() async => File(macosNodePathOf(root)).existsSync();

  // The controller uses FULI's macOS data directory, as the CLI does.
  @override
  Future<int> consolePort() => readConsolePort(defaultDataDir(os: 'macos', env: env));

  // src/setup/paths.js: <data>/logs holds runtime.log and the services' logs.
  @override
  Future<String> logDirectory() async => '${defaultDataDir(os: 'macos', env: env)}/logs';

  @override
  Future<RuntimeReport> status() => _action('status');

  @override
  Future<RuntimeReport> start({StageListener? onStage}) => _action('start', onStage: onStage);

  @override
  Future<RuntimeReport> stop() => _action('stop');

  // A reserved console port is a Windows problem.
  @override
  bool get canChangePort => false;

  @override
  Future<RuntimeReport> changePort({StageListener? onStage}) async =>
      const RuntimeReport(RuntimeState.unknown, error: 'Changing the port needs the Windows tray controller.');

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

  // The controller's lines are read as they arrive: the steps it reports while
  // it works, then the one result line at the end.
  Future<RuntimeReport> _action(String action, {StageListener? onStage, List<String> extra = const []}) async {
    if (!await locate()) return const RuntimeReport(RuntimeState.notFound);
    try {
      final process = await Process.start(macosNodePathOf(root), [macosControllerPathOf(root), action, ...extra],
          workingDirectory: root, environment: onStage == null ? null : stageMarkersEnvironment);
      unawaited(process.stderr.drain<void>());
      final output = StringBuffer();
      await process.stdout.transform(utf8.decoder).transform(const LineSplitter()).forEach((line) {
        output.writeln(line);
        if (parseStageLine(line) case final step?) onStage?.call(step.stage, step.maxSeconds);
      }).timeout(_controllerTimeout);
      return parseControllerReply(output.toString());
    } on ProcessException catch (error) {
      return RuntimeReport(RuntimeState.unknown, error: error.message);
    } on TimeoutException {
      return const RuntimeReport(RuntimeState.unknown, error: 'The FULI controller did not answer.');
    }
  }
}
