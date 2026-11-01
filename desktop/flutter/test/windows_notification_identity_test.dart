import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/platform/desktop/windows_notification_identity.dart';

import 'support/fake_registry.dart';

// The toast identity against an in-memory registry; the real HKCU is never
// read or written.
const _key = r'HKCU\Software\Classes\AppUserModelId\FULI';
const _root = r'C:\Users\a\AppData\Local\Programs\Fuli\versions\11111111-2222-3333-4444-555555555555';
const _icon = '$_root\\client\\data\\flutter_assets\\assets\\app\\fuli.png';

void main() {
  test('registers the name and the installed client\'s icon', () async {
    final registry = FakeRegistry();
    await WindowsNotificationIdentity(packageRoot: _root, reg: registry.call).apply();
    expect(registry.values, {'$_key|DisplayName': ('REG_SZ', 'FULI'), '$_key|IconUri': ('REG_SZ', _icon)});
  });

  test('an icon another build left is pointed back at the installed client; the matching name is only read', () async {
    final registry = FakeRegistry()
      ..values['$_key|DisplayName'] = ('REG_SZ', 'FULI')
      ..values['$_key|IconUri'] = ('REG_SZ', r'T:\fb\dev-build\data\flutter_assets\assets\app\fuli.png');
    await WindowsNotificationIdentity(packageRoot: _root, reg: registry.call).apply();
    expect(registry.values['$_key|IconUri'], ('REG_SZ', _icon));
    expect(registry.calls.where((args) => args.first == 'add').map((args) => args[3]), ['IconUri']);
  });

  test('an identity that already matches is only read', () async {
    final registry = FakeRegistry();
    final identity = WindowsNotificationIdentity(packageRoot: _root, reg: registry.call);
    await identity.apply();
    final calls = registry.calls.length;
    await identity.apply();
    expect(registry.calls.skip(calls).map((args) => args.first), ['query', 'query']);
  });
}
