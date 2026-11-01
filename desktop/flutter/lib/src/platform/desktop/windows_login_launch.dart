import 'windows_registry.dart';

const _runKey = r'HKCU\Software\Microsoft\Windows\CurrentVersion\Run';
const _runValue = 'FULI';
const _settingsKey = r'HKCU\Software\Fuli\DesktopClient';
const _choiceValue = 'LaunchAtLogin';

/// Starting the client when the person signs in to Windows: on for an
/// installed FULI until they turn it off in the tray menu. The entry runs the
/// package's Fuli.exe launcher with `--background` (tray icon only); updates,
/// rollbacks and uninstall keep it pointing at the installed version
/// (src/desktop/windows-desktop-client.js), and every start of the installed
/// version's client points it at itself again (installed_package.dart).
class WindowsLoginLaunch {
  WindowsLoginLaunch({required this.packageRoot, RegRunner reg = runReg}) : _reg = reg;

  final String packageRoot;
  final RegRunner _reg;

  String get command => '"$packageRoot\\Fuli.exe" --background';

  /// The person's choice; on until they turn it off.
  Future<bool> enabled() async {
    final result = await _reg(['query', _settingsKey, '/v', _choiceValue]);
    return result.exitCode != 0 || regValue('${result.stdout}', _choiceValue) != '0x0';
  }

  /// Makes the Run entry match the choice. Returns the choice.
  Future<bool> apply() async {
    final on = await enabled();
    final query = await _reg(['query', _runKey, '/v', _runValue]);
    final current = query.exitCode == 0 ? regValue('${query.stdout}', _runValue) : null;
    if (on && current != command) {
      await _reg(['add', _runKey, '/v', _runValue, '/t', 'REG_SZ', '/d', command, '/f']);
    } else if (!on && current != null) {
      await _reg(['delete', _runKey, '/v', _runValue, '/f']);
    }
    return on;
  }

  Future<bool> setEnabled(bool on) async {
    await _reg(['add', _settingsKey, '/v', _choiceValue, '/t', 'REG_DWORD', '/d', on ? '1' : '0', '/f']);
    return apply();
  }
}
