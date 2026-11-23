import 'dart:convert';

import 'fuli_runtime.dart';

// Reading what FULI's own entry points print:
// - src/desktop/windows-controller.js prints one JSON line
//   ({ok, status, state, error, notice, portBlocked} for an action,
//   {ok, dataDir, logDir, instanceKey} for `context`), after one
//   {"stage": …} line per startup step when this client asked for them;
// - `fuli status --json` prints one pretty JSON object; a login shell may add
//   its own lines around it.

RuntimeReport parseControllerReply(String stdout) {
  final reply = _lastJsonLine(stdout);
  if (reply == null) return const RuntimeReport(RuntimeState.unknown, error: 'The FULI tray controller printed no result.');
  final state = reply['state'];
  final error = reply['error'];
  final notice = reply['notice'];
  final stage = reply['stage'];
  final failed = reply['ok'] != true;
  return RuntimeReport(
    _state(reply['status']),
    consolePort: state is Map ? _consolePort(state) : null,
    error: failed ? (error is String ? error : null) : null,
    notice: notice is String && notice.isNotEmpty ? notice : null,
    portBlocked: reply['portBlocked'] == true,
    consoleStopped: state is Map && _consoleStopped(state),
    stage: !failed || stage is! String || stage.isEmpty ? null : stage,
    failure: failed ? _failure(reply['failure']) : null,
    autostartGaveUpAt: state is Map ? _gaveUpAt(state) : null,
  );
}

/// The failure a start reports on a line of its own (src/local-runtime/startup-failure.js),
/// or null for any other line.
StartupFailure? parseFailureLine(String line) {
  final value = _jsonObject(line);
  if (value == null || value.containsKey('ok')) return null;
  return _failure(value['failure']);
}

StartupFailure? _failure(Object? value) {
  if (value is! Map || value['code'] is! String) return null;
  return StartupFailure(value['code'] as String, Map<String, Object?>.from(value));
}

// `autostart` of the status report (src/local-runtime/lifecycle.js), present
// only while automatic restarts have given up.
String? _gaveUpAt(Map status) {
  final autostart = status['autostart'];
  return autostart is Map && autostart['gaveUp'] == true && autostart['at'] is String ? autostart['at'] as String : null;
}

Map? _jsonObject(String line) {
  final text = line.trim();
  if (!text.startsWith('{')) return null;
  try {
    final value = jsonDecode(text);
    return value is Map ? value : null;
  } on FormatException {
    return null;
  }
}

/// Asks a controller or the CLI for its startup steps as lines
/// (src/local-runtime/startup-stage.js). Without it they print only their
/// result, which every other caller of theirs reads whole.
const stageMarkersEnvironment = {'FULI_STAGE_MARKERS': '1'};

/// The step a controller reports while it works: one `{"stage": "…"}` line of
/// its own (src/desktop/desktop-controller.js `stageReporter`). The result
/// line carries `ok`, so it is never mistaken for one of these.
String? parseStageLine(String line) {
  final value = _jsonObject(line);
  if (value == null || value.containsKey('ok')) return null;
  final stage = value['stage'];
  return stage is String && stage.isNotEmpty ? stage : null;
}

/// The installation's data directory and the key of its one-client lock.
/// [currentPackageRoot] is set when this client runs from a version the
/// installation replaced (`status: superseded`): the version to open instead.
class ControllerContext {
  const ControllerContext({required this.dataDir, required this.instanceKey, this.currentPackageRoot, this.logDir});

  final String dataDir;
  final String? logDir;
  final String instanceKey;
  final String? currentPackageRoot;
}

ControllerContext? parseControllerContext(String stdout) {
  final reply = _lastJsonLine(stdout);
  final dataDir = reply?['dataDir'];
  final instanceKey = reply?['instanceKey'];
  final current = reply?['currentPackageRoot'];
  final superseded = reply?['status'] == 'superseded' && current is String && current.isNotEmpty;
  if ((reply?['ok'] != true && !superseded) || dataDir is! String || dataDir.isEmpty) return null;
  // windows-controller.js: the first 32 hex digits of the data directory's SHA-256.
  if (instanceKey is! String || !RegExp(r'^[0-9a-f]{32}$').hasMatch(instanceKey)) return null;
  final logDir = reply?['logDir'];
  return ControllerContext(dataDir: dataDir, instanceKey: instanceKey, currentPackageRoot: superseded ? current : null,
      logDir: logDir is String && logDir.isNotEmpty ? logDir : null);
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
  final console = status['console'];
  return RuntimeReport(_state(status['status']), consolePort: _consolePort(status),
      crashed: console is Map && console['crashed'] == true, consoleStopped: _consoleStopped(status),
      autostartGaveUpAt: _gaveUpAt(status));
}

// `console.status` of the status report (src/local-runtime/lifecycle.js): ready, unverified or stopped.
bool _consoleStopped(Map status) {
  final console = status['console'];
  return console is Map && console['status'] == 'stopped';
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
