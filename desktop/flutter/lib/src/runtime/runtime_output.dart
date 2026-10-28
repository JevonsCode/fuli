import 'dart:convert';

import 'fuli_runtime.dart';

// Reading what FULI's own entry points print:
// - src/desktop/windows-controller.js prints one JSON line
//   ({ok, status, state, error, notice, portBlocked} for an action,
//   {ok, dataDir, logDir, instanceKey} for `context`);
// - `fuli status --json` prints one pretty JSON object; a login shell may add
//   its own lines around it.

RuntimeReport parseControllerReply(String stdout) {
  final reply = _lastJsonLine(stdout);
  if (reply == null) return const RuntimeReport(RuntimeState.unknown, error: 'The FULI tray controller printed no result.');
  final state = reply['state'];
  final error = reply['error'];
  final notice = reply['notice'];
  return RuntimeReport(
    _state(reply['status']),
    consolePort: state is Map ? _consolePort(state) : null,
    error: reply['ok'] == true ? null : (error is String ? error : null),
    notice: notice is String && notice.isNotEmpty ? notice : null,
    portBlocked: reply['portBlocked'] == true,
  );
}

/// The installation's data directory and the key of its one-client lock.
class ControllerContext {
  const ControllerContext({required this.dataDir, required this.instanceKey});

  final String dataDir;
  final String instanceKey;
}

ControllerContext? parseControllerContext(String stdout) {
  final reply = _lastJsonLine(stdout);
  final dataDir = reply?['dataDir'];
  final instanceKey = reply?['instanceKey'];
  if (reply?['ok'] != true || dataDir is! String || dataDir.isEmpty) return null;
  // windows-controller.js: the first 32 hex digits of the data directory's SHA-256.
  if (instanceKey is! String || !RegExp(r'^[0-9a-f]{32}$').hasMatch(instanceKey)) return null;
  return ControllerContext(dataDir: dataDir, instanceKey: instanceKey);
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
