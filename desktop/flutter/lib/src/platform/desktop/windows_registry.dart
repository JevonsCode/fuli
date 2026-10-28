import 'dart:io';

// The current user's registry through reg.exe, the same tool the core uses
// for these entries (src/desktop/windows-desktop-client.js).

typedef RegRunner = Future<ProcessResult> Function(List<String> args);

Future<ProcessResult> runReg(List<String> args) =>
    Process.run('${Platform.environment['SystemRoot'] ?? r'C:\Windows'}\\System32\\reg.exe', args);

/// The data of [name] in `reg query` output, or null when it is not there.
String? regValue(String stdout, String name) {
  for (final line in stdout.split(RegExp(r'\r?\n'))) {
    final match = RegExp(r'^\s*(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*?)\s*$').firstMatch(line);
    if (match != null && match.group(1)!.toLowerCase() == name.toLowerCase()) return match.group(3);
  }
  return null;
}
