import 'dart:convert';
import 'dart:io';

// Where the console listens, read the way the core reads it:
// `ports.console` in `<data dir>/runtime-settings.json`
// (src/system/runtime-settings.js), 2727 when absent. The default data
// directory follows src/setup/paths.js.

const defaultConsolePort = 2727;

String defaultDataDir({required String os, required Map<String, String> env}) {
  String? nonEmpty(String? value) => value != null && value.trim().isNotEmpty ? value : null;
  final explicit = nonEmpty(env['FULI_DATA_DIR']);
  if (explicit != null) return explicit;
  final home = nonEmpty(env['HOME']) ?? nonEmpty(env['USERPROFILE']) ?? '';
  return switch (os) {
    'windows' => '${nonEmpty(env['LOCALAPPDATA']) ?? '$home\\AppData\\Local'}\\Fuli',
    'macos' => '$home/Library/Application Support/Fuli',
    _ => '${nonEmpty(env['XDG_DATA_HOME']) ?? '$home/.local/share'}/fuli',
  };
}

Future<int> readConsolePort(String dataDir) async {
  final file = File('$dataDir${Platform.pathSeparator}runtime-settings.json');
  try {
    final settings = jsonDecode(await file.readAsString());
    final ports = settings is Map ? settings['ports'] : null;
    final port = ports is Map ? ports['console'] : null;
    if (port is int && port > 0 && port < 65536) return port;
  } on FileSystemException {
    // No settings yet: FULI uses its default port.
  } on FormatException {
    // A settings file FULI itself would refuse; keep the default.
  }
  return defaultConsolePort;
}
