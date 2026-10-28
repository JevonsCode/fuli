import 'dart:convert';

import 'fuli_runtime.dart';

// Reading what FULI's own entry points print:
// - src/desktop/windows-controller.js prints one JSON line
//   ({ok, status, state, error} for an action, {ok, dataDir} for `context`);
// - `fuli status --json` prints one pretty JSON object; a login shell may add
//   its own lines around it.

RuntimeReport parseControllerReply(String stdout) {
  final reply = _lastJsonLine(stdout);
  if (reply == null) return const RuntimeReport(RuntimeState.unknown, error: 'The FULI tray controller printed no result.');
  final state = reply['state'];
  final error = reply['error'];
  return RuntimeReport(
    _state(reply['status']),
    consolePort: state is Map ? _consolePort(state) : null,
    error: reply['ok'] == true ? null : (error is String ? error : null),
  );
}

String? parseControllerDataDir(String stdout) {
  final reply = _lastJsonLine(stdout);
  final dataDir = reply?['dataDir'];
  return reply?['ok'] == true && dataDir is String && dataDir.isNotEmpty ? dataDir : null;
}

RuntimeReport parseCliStatus(String stdout) {
  final start = stdout.indexOf('{');
  final end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return const RuntimeReport(RuntimeState.unknown, error: 'fuli status printed no JSON.');
  }
  final Object? status;
  try {
    status = jsonDecode(stdout.substring(start, end + 1));
  } on FormatException {
    return const RuntimeReport(RuntimeState.unknown, error: 'fuli status printed invalid JSON.');
  }
  if (status is! Map) return const RuntimeReport(RuntimeState.unknown, error: 'fuli status printed invalid JSON.');
  return RuntimeReport(_state(status['status']), consolePort: _consolePort(status));
}

Map? _lastJsonLine(String stdout) {
  final lines = const LineSplitter().convert(stdout).where((line) => line.trim().startsWith('{'));
  if (lines.isEmpty) return null;
  try {
    final value = jsonDecode(lines.last);
    return value is Map ? value : null;
  } on FormatException {
    return null;
  }
}

RuntimeState _state(Object? status) => switch (status) {
      'running' => RuntimeState.running,
      'stopped' => RuntimeState.stopped,
      'degraded' || 'partial' => RuntimeState.degraded,
      'not_configured' => RuntimeState.notConfigured,
      _ => RuntimeState.unknown,
    };

// `console.url` of `fuli status --json`, e.g. http://127.0.0.1:2727/.
int? _consolePort(Map status) {
  final console = status['console'];
  final url = console is Map ? console['url'] : null;
  if (url is! String) return null;
  final uri = Uri.tryParse(url);
  return uri != null && uri.hasPort && uri.port > 0 ? uri.port : null;
}
