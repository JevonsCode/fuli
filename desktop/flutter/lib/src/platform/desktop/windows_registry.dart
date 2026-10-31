import 'dart:io';

// The current user's registry through reg.exe, the same tool the core uses
// for these entries (src/desktop/windows-desktop-client.js).

typedef RegRunner = Future<ProcessResult> Function(List<String> args);

Future<ProcessResult> runReg(List<String> args) =>
    Process.run('${Platform.environment['SystemRoot'] ?? r'C:\Windows'}\\System32\\reg.exe', args);

final _valueLine = RegExp(r'^\s*(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*?)\s*$');

Iterable<RegExpMatch> _values(String stdout) => stdout.split(RegExp(r'\r?\n')).map(_valueLine.firstMatch).nonNulls;

/// The data of [name] in `reg query` output, or null when it is not there.
String? regValue(String stdout, String name) {
  for (final match in _values(stdout)) {
    if (match.group(1)!.toLowerCase() == name.toLowerCase()) return match.group(3);
  }
  return null;
}

/// The data of a key's default value in `reg query <key> /ve` output, the
/// only value it lists. Its name is localized ("(Default)", "(默认)").
String? regDefaultValue(String stdout) => _values(stdout).firstOrNull?.group(3);
