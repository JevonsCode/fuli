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

/// Runs the tray's controller (`node.exe windows-controller.js <action>`), the
/// same entry point FuliTray.exe uses, and reads its one-line JSON answer.
class WindowsTrayRuntime implements FuliRuntime {
  WindowsTrayRuntime({required this.exeDir, required this.env});

  final String exeDir;
  final Map<String, String> env;
  String? _root;
  String? _dataDir;

  @override
  Future<bool> locate() async {
    final root = await locateTrayInstall(exeDir: exeDir, env: env);
    if (root != _root) {
      _root = root;
      // The installation names its data directory; ask once per installation.
      _dataDir = root == null ? null : parseControllerDataDir(await _run(root, 'context'));
    }
    return root != null;
  }

  @override
  Future<int> consolePort() => readConsolePort(_dataDir ?? defaultDataDir(os: 'windows', env: env));

  @override
  Future<RuntimeReport> status() => _action('status');

  @override
  Future<RuntimeReport> start() => _action('start');

  @override
  Future<RuntimeReport> stop() => _action('stop');

  Future<RuntimeReport> _action(String action) async {
    if (!await locate()) return const RuntimeReport(RuntimeState.notFound);
    return parseControllerReply(await _run(_root!, action));
  }

  // detachedWithStdio keeps Windows from opening a console window for
  // node.exe under this GUI process; its exit code is not available, so the
  // controller's JSON `ok` field carries the outcome.
  Future<String> _run(String root, String action) async {
    try {
      final process = await Process.start(
        nodePathOf(root),
        [controllerPathOf(root), action],
        workingDirectory: root,
        mode: ProcessStartMode.detachedWithStdio,
      );
      unawaited(process.stderr.drain<void>());
      return await process.stdout.transform(utf8.decoder).join().timeout(_controllerTimeout);
    } on ProcessException catch (error) {
      return jsonEncode({'ok': false, 'status': 'unknown', 'error': error.message});
    } on TimeoutException {
      return jsonEncode({'ok': false, 'status': 'unknown', 'error': 'The FULI tray controller did not answer.'});
    }
  }
}
