import 'dart:io';

import '../../runtime/tray_install.dart';

/// The installed Windows package this client runs from (the Fuli.exe
/// launcher's folder, one above the client's) when it is the version its
/// installation runs now (`<install root>\installation.json`), otherwise null.
/// Only that package registers itself with Windows: launch at login, fuli://
/// links and the notification identity are one per user, so a build or
/// package copy outside an installation, and an older version kept for
/// rollback, leave them alone.
Future<String?> installedPackageRoot(String exeDir) async {
  final root = Directory(exeDir).parent;
  if (!File('${root.path}\\installed-context.json').existsSync()) return null;
  final current = await installedVersion(root.parent.parent.path);
  return current != null && _samePath(current, root.path) ? root.path : null;
}

// Windows paths compare without case and trailing separators.
bool _samePath(String a, String b) {
  String plain(String path) => path.replaceAll('/', r'\').replaceFirst(RegExp(r'\\+$'), '').toLowerCase();
  return plain(a) == plain(b);
}
