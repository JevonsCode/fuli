import 'dart:io';

/// The installed Windows package this client runs from (the Fuli.exe
/// launcher's folder, one above the client's), or null for a package that
/// was never installed. Only an installed package registers itself with
/// Windows: launch at login and fuli:// links.
String? installedPackageRoot(String exeDir) {
  final root = Directory(exeDir).parent.path;
  return File('$root\\installed-context.json').existsSync() ? root : null;
}
