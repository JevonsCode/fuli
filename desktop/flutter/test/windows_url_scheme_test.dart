import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/platform/desktop/windows_url_scheme.dart';

import 'support/fake_registry.dart';

// The fuli:// scheme against an in-memory registry; the real HKCU is never
// read or written.
const _scheme = r'HKCU\Software\Classes\fuli';
const _command = '$_scheme\\shell\\open\\command';
const _root = r'C:\Users\a\AppData\Local\Programs\Fuli\versions\11111111-2222-3333-4444-555555555555';

void main() {
  test('registers the scheme to open the installed launcher with the link', () async {
    final registry = FakeRegistry();
    await WindowsUrlScheme(packageRoot: _root, reg: registry.call).apply();
    expect(registry.values, {
      '$_scheme|': ('REG_SZ', 'URL:FULI'),
      '$_scheme|URL Protocol': ('REG_SZ', ''),
      '$_command|': ('REG_SZ', '"$_root\\Fuli.exe" "%1"'),
    });
  });

  test('a scheme that already opens this package is only read, under any localized default name', () async {
    final registry = FakeRegistry(defaultName: '(默认)');
    final scheme = WindowsUrlScheme(packageRoot: _root, reg: registry.call);
    await scheme.apply();
    final calls = registry.calls.length;
    await scheme.apply();
    expect(registry.calls.length, calls + 1);
    expect(registry.calls.last.first, 'query');
  });

  test('a start from another version points the scheme at this one', () async {
    final registry = FakeRegistry();
    await WindowsUrlScheme(packageRoot: r'C:\old', reg: registry.call).apply();
    await WindowsUrlScheme(packageRoot: _root, reg: registry.call).apply();
    expect(registry.values['$_command|']?.$2, '"$_root\\Fuli.exe" "%1"');
  });
}
