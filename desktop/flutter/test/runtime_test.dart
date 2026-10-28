import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/runtime/console_port.dart';
import 'package:fuli_desktop/src/runtime/fuli_runtime.dart';
import 'package:fuli_desktop/src/runtime/runtime_output.dart';
import 'package:fuli_desktop/src/runtime/tray_install.dart';

// Synthetic directories under the system temp folder only; never the real
// data directory, never the real ports.
void main() {
  late Directory temp;

  setUp(() => temp = Directory.systemTemp.createTempSync('fuli-desktop-test-'));
  tearDown(() => temp.deleteSync(recursive: true));

  String path(List<String> parts) => [temp.path, ...parts].join(Platform.pathSeparator);

  void writeFile(List<String> parts, String content) {
    File(path(parts))
      ..createSync(recursive: true)
      ..writeAsStringSync(content);
  }

  group('console port', () {
    test('reads ports.console from runtime-settings.json', () async {
      writeFile(['runtime-settings.json'], jsonEncode({'version': 1, 'ports': {'console': 4311, 'personalProvider': 4312}}));
      expect(await readConsolePort(temp.path), 4311);
    });

    test('defaults to 2727 without settings or with an unusable value', () async {
      expect(await readConsolePort(temp.path), defaultConsolePort);
      writeFile(['runtime-settings.json'], '{"ports":{"console":"4311"}}');
      expect(await readConsolePort(temp.path), defaultConsolePort);
      writeFile(['runtime-settings.json'], 'not json');
      expect(await readConsolePort(temp.path), defaultConsolePort);
    });

    test('default data directories follow the core', () {
      expect(defaultDataDir(os: 'windows', env: {'LOCALAPPDATA': r'C:\Users\a\AppData\Local'}),
          r'C:\Users\a\AppData\Local\Fuli');
      expect(defaultDataDir(os: 'macos', env: {'HOME': '/Users/a'}), '/Users/a/Library/Application Support/Fuli');
      expect(defaultDataDir(os: 'linux', env: {'HOME': '/home/a'}), '/home/a/.local/share/fuli');
      expect(defaultDataDir(os: 'linux', env: {'HOME': '/home/a', 'XDG_DATA_HOME': '/xdg'}), '/xdg/fuli');
      expect(defaultDataDir(os: 'macos', env: {'HOME': '/Users/a', 'FULI_DATA_DIR': '/custom'}), '/custom');
    });
  });

  group('controller output', () {
    test('reads an action reply, its state and the console port', () {
      final line = jsonEncode({
        'ok': true, 'action': 'status', 'status': 'running', 'label': '运行中 / Running',
        'state': {'status': 'running', 'console': {'status': 'ready', 'url': 'http://127.0.0.1:4311'}},
      });
      final report = parseControllerReply('$line\n');
      expect(report.state, RuntimeState.running);
      expect(report.consolePort, 4311);
      expect(report.error, isNull);
    });

    test('a failed action keeps its error and state', () {
      final report = parseControllerReply(jsonEncode(
          {'ok': false, 'action': 'start', 'status': 'stopped', 'error': 'Fuli did not reach its running state.'}));
      expect(report.state, RuntimeState.stopped);
      expect(report.error, 'Fuli did not reach its running state.');
      expect(parseControllerReply('{"ok":true,"status":"not_configured"}').state, RuntimeState.notConfigured);
      expect(parseControllerReply('{"ok":true,"status":"degraded"}').state, RuntimeState.degraded);
    });

    test('no output or garbage is an unknown state, not a crash', () {
      expect(parseControllerReply('').state, RuntimeState.unknown);
      expect(parseControllerReply('{broken').state, RuntimeState.unknown);
      expect(parseControllerReply('').error, isNotNull);
    });

    test('context names the data directory and the one-client lock key', () {
      final key = 'a' * 32;
      final context = parseControllerContext(
          jsonEncode({'ok': true, 'dataDir': r'D:\FuliData', 'logDir': r'D:\FuliData\logs', 'instanceKey': key}));
      expect(context?.dataDir, r'D:\FuliData');
      expect(context?.instanceKey, key);
      expect(parseControllerContext(jsonEncode({'ok': false, 'status': 'unknown', 'error': 'x'})), isNull);
      // A key that is not the controller's hex digest never names a lock.
      expect(parseControllerContext(jsonEncode({'ok': true, 'dataDir': r'D:\FuliData', 'instanceKey': r'x\..\y'})), isNull);
      expect(parseControllerContext(jsonEncode({'ok': true, 'dataDir': r'D:\FuliData'})), isNull);
    });

    test('a port change says what changed; a start on a reserved port says the port change fixes it', () {
      final moved = parseControllerReply(jsonEncode({'ok': true, 'action': 'change-port', 'status': 'running',
          'notice': 'Fuli now uses port 4321 (was 2727).',
          'state': {'status': 'running', 'console': {'url': 'http://127.0.0.1:4321'}}}));
      expect(moved.notice, 'Fuli now uses port 4321 (was 2727).');
      expect(moved.consolePort, 4321);
      expect(moved.portBlocked, isFalse);
      final blocked = parseControllerReply(
          jsonEncode({'ok': false, 'action': 'start', 'status': 'stopped', 'error': 'EACCES', 'portBlocked': true}));
      expect(blocked.portBlocked, isTrue);
      expect(blocked.error, 'EACCES');
    });

    test('fuli status --json is read through login-shell noise', () {
      const stdout = 'Welcome back\n{\n  "status": "stopped",\n  "console": {"status": "stopped", "url": "http://127.0.0.1:4400"}\n}\n';
      final report = parseCliStatus(stdout);
      expect(report.state, RuntimeState.stopped);
      expect(report.consolePort, 4400);
      expect(parseCliStatus('fuli: command not found').state, RuntimeState.unknown);
    });
  });

  group('tray installation', () {
    void install(List<String> root, {String version = '0.22.0'}) {
      writeFile([...root, 'runtime', 'node', 'node.exe'], '');
      writeFile([...root, 'src', 'desktop', 'windows-controller.js'], '');
      writeFile([...root, 'package.json'], jsonEncode({'version': version}));
    }

    test('prefers the tray folder the client ships in', () async {
      install(['bundle']);
      Directory(path(['bundle', 'desktop'])).createSync();
      final found = await locateTrayInstall(exeDir: path(['bundle', 'desktop']), env: {'LOCALAPPDATA': temp.path});
      expect(found, path(['bundle']));
    });

    test('uses the active version named by installation.json', () async {
      install(['Programs', 'Fuli', 'versions', 'old']);
      install(['Programs', 'Fuli', 'versions', 'newer']);
      writeFile(['Programs', 'Fuli', 'installation.json'],
          jsonEncode({'status': 'installed', 'packageRoot': path(['Programs', 'Fuli', 'versions', 'old'])}));
      final found = await locateTrayInstall(exeDir: path(['elsewhere', 'app']), env: {'LOCALAPPDATA': temp.path});
      expect(found, path(['Programs', 'Fuli', 'versions', 'old']));
    });

    test('falls back to the newest complete version folder', () async {
      install(['Programs', 'Fuli', 'versions', 'a']);
      install(['Programs', 'Fuli', 'versions', 'b']);
      Directory(path(['Programs', 'Fuli', 'versions', 'incomplete'])).createSync(recursive: true);
      File(path(['Programs', 'Fuli', 'versions', 'a', 'package.json'])).setLastModifiedSync(DateTime(2026, 1, 1));
      File(path(['Programs', 'Fuli', 'versions', 'b', 'package.json'])).setLastModifiedSync(DateTime(2026, 6, 1));
      final found = await locateTrayInstall(exeDir: path(['elsewhere', 'app']), env: {'LOCALAPPDATA': temp.path});
      expect(found, path(['Programs', 'Fuli', 'versions', 'b']));
    });

    test('finds nothing without a complete installation', () async {
      writeFile(['Programs', 'Fuli', 'versions', 'x', 'runtime', 'node', 'node.exe'], '');
      expect(await locateTrayInstall(exeDir: path(['elsewhere', 'app']), env: {'LOCALAPPDATA': temp.path}), isNull);
      expect(await locateTrayInstall(exeDir: path(['elsewhere', 'app']), env: const {}), isNull);
    });
  });
}
