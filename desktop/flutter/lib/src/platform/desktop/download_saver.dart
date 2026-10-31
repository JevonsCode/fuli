import 'dart:io';

import 'windows_registry.dart';

/// Saves a file the console page made (an export) into the person's
/// Downloads folder. The page cannot save it itself inside the client's
/// WebView, so it hands the text over (web/src/lib/save-file.ts) and waits:
/// what depends on the file, such as a delete, goes ahead only once it is
/// on disk.
class DownloadSaver {
  DownloadSaver({Future<Directory> Function()? folder}) : _folder = folder ?? downloadsFolder;

  final Future<Directory> Function() _folder;

  // An export is text the console wrote; anything larger is not one of them.
  static const maxCharacters = 32 * 1024 * 1024;

  Future<File> save(String name, String content) async {
    if (content.length > maxCharacters) throw const FileSystemException('The file is too large to save');
    final folder = await _folder();
    await folder.create(recursive: true);
    final safe = safeFileName(name);
    final dot = safe.lastIndexOf('.');
    final (stem, extension) = dot > 0 ? (safe.substring(0, dot), safe.substring(dot)) : (safe, '');
    var file = File('${folder.path}${Platform.pathSeparator}$safe');
    for (var copy = 2; await file.exists(); copy++) {
      file = File('${folder.path}${Platform.pathSeparator}$stem ($copy)$extension');
    }
    return file.writeAsString(content, flush: true);
  }
}

/// The page's suggested name as one plain file name: no folders, no
/// characters Windows or macOS reject, never empty.
String safeFileName(String name) {
  final cleaned = name
      .split(RegExp(r'[\\/]'))
      .last
      .replaceAll(RegExp(r'[<>:"|?*\x00-\x1f]'), '-')
      .replaceAll(RegExp(r'^[\s.]+|[\s.]+$'), '');
  if (cleaned.isEmpty) return 'fuli-export';
  return cleaned.length <= 120 ? cleaned : cleaned.substring(cleaned.length - 120);
}

const _downloadsKey = r'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders';
const _downloadsValue = '{374DE290-123F-4565-9164-39C4925E467B}';

/// The Downloads folder: on Windows where the person moved it, if they did.
Future<Directory> downloadsFolder({RegRunner run = runReg, Map<String, String>? environment}) async {
  final env = environment ?? Platform.environment;
  if (Platform.isWindows || env.containsKey('USERPROFILE')) {
    final profile = env['USERPROFILE'] ?? '';
    try {
      final result = await run(['query', _downloadsKey, '/v', _downloadsValue]);
      final value = result.exitCode == 0 ? regValue('${result.stdout}', _downloadsValue) : null;
      if (value != null && value.isNotEmpty) {
        return Directory(value.replaceAllMapped(RegExp('%([^%]+)%', caseSensitive: false),
            (match) => env[match[1]!] ?? env[match[1]!.toUpperCase()] ?? match[0]!));
      }
    } on Object {
      // Fall back to the default location below.
    }
    return Directory('$profile\\Downloads');
  }
  return Directory('${env['HOME'] ?? '.'}/Downloads');
}
