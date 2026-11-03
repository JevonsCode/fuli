import 'dart:io';

import '../../app/check_log.dart';

/// The check log as a small text file under FULI's data directory
/// (logs/desktop-checks.log), one line per failed check. Past 256 KB the file
/// moves to desktop-checks.log.1, replacing the previous one, so it never
/// grows without bound. Writing never fails a check.
class FileCheckLog implements CheckLog {
  FileCheckLog(String dataDir) : _path = '$dataDir${Platform.pathSeparator}logs${Platform.pathSeparator}desktop-checks.log';

  static const _limitBytes = 256 * 1024;
  static const _reasonChars = 200;
  final String _path;

  @override
  void failed(DateTime at, String kind, String reason) {
    final short = reason.replaceAll(RegExp(r'\s+'), ' ');
    final line = '${at.toUtc().toIso8601String()} $kind ${short.length > _reasonChars ? short.substring(0, _reasonChars) : short}\n';
    try {
      final file = File(_path);
      file.parent.createSync(recursive: true);
      if (file.existsSync() && file.lengthSync() > _limitBytes) file.renameSync('$_path.1');
      file.writeAsStringSync(line, mode: FileMode.append, flush: true);
    } on FileSystemException {
      // The log is a help, not a duty: a full disk or a locked file leaves the check as it was.
    }
  }
}
