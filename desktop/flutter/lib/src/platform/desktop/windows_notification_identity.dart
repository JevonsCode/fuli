import 'windows_registry.dart';

/// The app id FULI's Windows toasts are shown under.
const notificationAppId = 'FULI';
const _key = r'HKCU\Software\Classes\AppUserModelId\' + notificationAppId;

/// Windows shows toasts of an unpackaged app for an identity registered under
/// the current user's AppUserModelId key: its name and the installed client's
/// icon. Updates and rollbacks point the icon at the version they install, and
/// uninstall removes the key (src/desktop/windows-desktop-client.js); every
/// start of the installed client points it at itself again.
class WindowsNotificationIdentity {
  WindowsNotificationIdentity({required this.packageRoot, RegRunner reg = runReg}) : _reg = reg;

  final String packageRoot;
  final RegRunner _reg;

  String get icon => '$packageRoot\\client\\data\\flutter_assets\\assets\\app\\fuli.png';

  /// Writes each value that is missing or differs; matching values are only read.
  Future<void> apply() async {
    for (final (name, data) in [('DisplayName', 'FULI'), ('IconUri', icon)]) {
      final query = await _reg(['query', _key, '/v', name]);
      if (query.exitCode == 0 && regValue('${query.stdout}', name) == data) continue;
      await _reg(['add', _key, '/v', name, '/t', 'REG_SZ', '/d', data, '/f']);
    }
  }
}
