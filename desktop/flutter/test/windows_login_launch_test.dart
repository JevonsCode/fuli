import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/platform/desktop/windows_login_launch.dart';
import 'package:fuli_desktop/src/platform/desktop/windows_registry.dart';

import 'support/fake_registry.dart';

// Launch at login against an in-memory registry behind a fake reg.exe; the
// real HKCU is never read or written.
const _run = r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run';
const _settings = r'HKCU\Software\Fuli\DesktopClient';
const _root = r'C:\Users\a\AppData\Local\Programs\Fuli\versions\11111111-2222-3333-4444-555555555555';

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

  test('reg query output is read by value name, and the default value whatever its localized name', () {
    const stdout = '\r\nHKEY_CURRENT_USER\\Software\\Fuli\\DesktopClient\r\n    LaunchAtLogin    REG_DWORD    0x1\r\n\r\n';
    expect(regValue(stdout, 'LaunchAtLogin'), '0x1');
    expect(regValue(stdout, 'Other'), isNull);
    const command = '\r\nHKEY_CURRENT_USER\\Software\\Classes\\fuli\\shell\\open\\command\r\n    (默认)    REG_SZ    "C:\\F\\Fuli.exe" "%1"\r\n\r\n';
    expect(regDefaultValue(command), r'"C:\F\Fuli.exe" "%1"');
    expect(regDefaultValue('\r\nHKEY_CURRENT_USER\\Software\\Classes\\fuli\r\n'), isNull);
  });
}
