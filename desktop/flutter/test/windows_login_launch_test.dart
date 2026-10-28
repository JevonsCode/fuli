import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/platform/desktop/windows_login_launch.dart';
import 'package:fuli_desktop/src/platform/desktop/windows_registry.dart';

// Launch at login against an in-memory registry behind a fake reg.exe; the
// real HKCU is never read or written.
const _run = r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run';
const _settings = r'HKCU\Software\Fuli\DesktopClient';
const _root = r'C:\Users\a\AppData\Local\Programs\Fuli\versions\11111111-2222-3333-4444-555555555555';

class FakeRegistry {
  final Map<String, (String, String)> values = {};
  final List<List<String>> calls = [];

  Future<ProcessResult> call(List<String> args) async {
    calls.add(args);
    final key = args[1];
    final name = args.contains('/v') ? args[args.indexOf('/v') + 1] : '';
    final id = '$key|$name';
    switch (args.first) {
      case 'query':
        final value = values[id];
        if (value == null) return ProcessResult(0, 1, '', 'ERROR: The system was unable to find the specified registry key or value.');
        return ProcessResult(0, 0, '\r\n$key\r\n    $name    ${value.$1}    ${value.$2}\r\n\r\n', '');
      case 'add':
        final type = args[args.indexOf('/t') + 1];
        final data = args[args.indexOf('/d') + 1];
        values[id] = (type, type == 'REG_DWORD' ? '0x${int.parse(data).toRadixString(16)}' : data);
        return ProcessResult(0, 0, 'The operation completed successfully.', '');
      case 'delete':
        values.remove(id);
        return ProcessResult(0, 0, 'The operation completed successfully.', '');
    }
    return ProcessResult(0, 1, '', 'unsupported');
  }
}

void main() {
  late FakeRegistry registry;
  late WindowsLoginLaunch launch;

  setUp(() {
    registry = FakeRegistry();
    launch = WindowsLoginLaunch(packageRoot: _root, reg: registry.call);
  });

  test('is on by default and starts the installed launcher in the background', () async {
    expect(await launch.apply(), isTrue);
    expect(registry.values['$_run|FULI'], ('REG_SZ', '"$_root\\Fuli.exe" --background'));
    final writes = registry.calls.length;
    expect(await launch.apply(), isTrue);
    expect(registry.calls.length, writes + 2, reason: 'an entry that already matches is only read');
  });

  test('a start from another version points the entry at this one', () async {
    registry.values['$_run|FULI'] = ('REG_SZ', r'"C:\Users\a\AppData\Local\Programs\Fuli\versions\old\Fuli.exe" --background');
    await launch.apply();
    expect(registry.values['$_run|FULI']?.$2, '"$_root\\Fuli.exe" --background');
  });

  test('turning it off removes the entry and is remembered; turning it on brings it back', () async {
    await launch.apply();
    expect(await launch.setEnabled(false), isFalse);
    expect(registry.values.containsKey('$_run|FULI'), isFalse);
    expect(registry.values['$_settings|LaunchAtLogin'], ('REG_DWORD', '0x0'));
    expect(await launch.apply(), isFalse, reason: 'the next start keeps the choice');
    expect(registry.values.containsKey('$_run|FULI'), isFalse);
    expect(await launch.setEnabled(true), isTrue);
    expect(registry.values['$_run|FULI']?.$2, '"$_root\\Fuli.exe" --background');
  });

  test('reg query output is read by value name', () {
    const stdout = '\r\nHKEY_CURRENT_USER\\Software\\Fuli\\DesktopClient\r\n    LaunchAtLogin    REG_DWORD    0x1\r\n\r\n';
    expect(regValue(stdout, 'LaunchAtLogin'), '0x1');
    expect(regValue(stdout, 'Other'), isNull);
  });

  test('only an installed package offers it', () {
    final temp = Directory.systemTemp.createTempSync('fuli-login-launch-');
    addTearDown(() => temp.deleteSync(recursive: true));
    final client = Directory('${temp.path}${Platform.pathSeparator}client')..createSync();
    expect(WindowsLoginLaunch.forClient(client.path), isNull);
    File('${temp.path}${Platform.pathSeparator}installed-context.json').writeAsStringSync('{}');
    // forClient joins with a backslash, as on Windows; elsewhere the file is not found.
    expect(WindowsLoginLaunch.forClient(client.path)?.packageRoot, Platform.isWindows ? temp.path : null);
  });
}
