import 'dart:convert';
import 'dart:io';

// Finding a Windows tray installation of FULI. The client will ship inside the
// tray package, so its own parent folder comes first; otherwise the per-user
// install root (src/desktop/windows-installation.js) names its active version
// in installation.json, and the newest complete version folder is the fallback.

String _join(List<String> parts) => parts.join(Platform.pathSeparator);

String nodePathOf(String root) => _join([root, 'runtime', 'node', 'node.exe']);

String controllerPathOf(String root) => _join([root, 'src', 'desktop', 'windows-controller.js']);

bool _complete(String root) => File(nodePathOf(root)).existsSync() && File(controllerPathOf(root)).existsSync();

Future<String?> locateTrayInstall({required String exeDir, required Map<String, String> env}) async {
  final bundled = Directory(exeDir).parent.path;
  if (_complete(bundled)) return bundled;
  final localAppData = env['LOCALAPPDATA'];
  if (localAppData == null || localAppData.isEmpty) return null;
  final installRoot = _join([localAppData, 'Programs', 'Fuli']);

  final active = await _activeVersion(installRoot);
  if (active != null && _complete(active)) return active;

  final versions = Directory(_join([installRoot, 'versions']));
  if (!versions.existsSync()) return null;
  final complete = <(String, DateTime)>[];
  await for (final entry in versions.list(followLinks: false)) {
    if (entry is! Directory || !_complete(entry.path)) continue;
    final package = File(_join([entry.path, 'package.json']));
    complete.add((entry.path, package.existsSync() ? package.lastModifiedSync() : entry.statSync().modified));
  }
  if (complete.isEmpty) return null;
  complete.sort((a, b) => b.$2.compareTo(a.$2));
  return complete.first.$1;
}

Future<String?> _activeVersion(String installRoot) async {
  try {
    final record = jsonDecode(await File(_join([installRoot, 'installation.json'])).readAsString());
    if (record is Map && record['status'] == 'installed' && record['packageRoot'] is String) {
      return record['packageRoot'] as String;
    }
  } on FileSystemException {
    // Not installed through Install-Fuli.cmd.
  } on FormatException {
    // A damaged record: fall back to the version folders.
  }
  return null;
}
