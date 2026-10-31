import 'windows_registry.dart';

const _schemeKey = r'HKCU\Software\Classes\fuli';
const _commandKey = '$_schemeKey\\shell\\open\\command';

/// `fuli://` links open this client: the entry runs the package's Fuli.exe
/// launcher with the link. Updates, rollbacks and uninstall keep it pointing
/// at the installed version (src/desktop/windows-desktop-client.js), and every
/// start of an installed client points it at itself again.
class WindowsUrlScheme {
  WindowsUrlScheme({required this.packageRoot, RegRunner reg = runReg}) : _reg = reg;

  final String packageRoot;
  final RegRunner _reg;

  String get command => '"$packageRoot\\Fuli.exe" "%1"';

  /// Registers the scheme unless it already opens this package.
  Future<void> apply() async {
    final query = await _reg(['query', _commandKey, '/ve']);
    if (query.exitCode == 0 && regDefaultValue('${query.stdout}') == command) return;
    await _reg(['add', _schemeKey, '/ve', '/t', 'REG_SZ', '/d', 'URL:FULI', '/f']);
    await _reg(['add', _commandKey, '/ve', '/t', 'REG_SZ', '/d', command, '/f']);
    await _reg(['add', _schemeKey, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f']);
  }
}
