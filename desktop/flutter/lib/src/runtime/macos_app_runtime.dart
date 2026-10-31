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

  @override
  Future<RuntimeReport> status() => _action('status');

  @override
  Future<RuntimeReport> start() => _action('start');

  @override
  Future<RuntimeReport> stop() => _action('stop');

  // A reserved console port is a Windows problem.
  @override
  bool get canChangePort => false;

  @override
  Future<RuntimeReport> changePort() async =>
      const RuntimeReport(RuntimeState.unknown, error: 'Changing the port needs the Windows tray controller.');

  Future<RuntimeReport> _action(String action) async {
    if (!await locate()) return const RuntimeReport(RuntimeState.notFound);
    try {
      final result = await Process.run(macosNodePathOf(root), [macosControllerPathOf(root), action],
              workingDirectory: root, stdoutEncoding: utf8, stderrEncoding: utf8)
          .timeout(_controllerTimeout);
      return parseControllerReply('${result.stdout}');
    } on ProcessException catch (error) {
      return RuntimeReport(RuntimeState.unknown, error: error.message);
    } on TimeoutException {
      return const RuntimeReport(RuntimeState.unknown, error: 'The FULI controller did not answer.');
    }
  }
}
