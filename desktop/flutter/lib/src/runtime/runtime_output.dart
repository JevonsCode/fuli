import 'dart:async';
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
    lockKept: failed ? _failure(reply['lockRelease'], code: 'reason') : null,
    recoveryPlan: parseRecoveryPlan(reply['recoveryPlan']),
    recoveryRecord: reply['recoveryRecord'] is String ? reply['recoveryRecord'] as String : null,
    keptGraphData: [
      if (reply['keptGraphData'] is List)
        for (final folder in reply['keptGraphData'] as List) if (folder is Map) Map<String, Object?>.from(folder),
    ],
    importAbandoned: reply['importAbandoned'] is String ? reply['importAbandoned'] as String : null,
  );
}

/// The steps in which a controller imports a graph or gives an import up
/// (src/desktop/desktop-controller.js): it goes on in the background however
/// long it takes, so the window does not give up on it after the usual wait.
const importStages = {'graph_import', 'import_abandon'};

/// How long the window waits for a controller: [usual] for anything, and in
/// an import step up to [importing] (a whole graph can take hours).
const controllerWait = (usual: Duration(minutes: 10), importing: Duration(hours: 24));

/// What a controller printed, read line by line as it arrives (each step it
/// reports goes to [onStage]), until it ends or the wait for its current step
/// runs out: [timedOut], and [importing] when that step was an import.
Future<({String output, bool timedOut, bool importing})> readControllerLines(Stream<List<int>> stdout, StageListener? onStage,
    {({Duration usual, Duration importing}) wait = controllerWait}) async {
  final output = StringBuffer();
  String? stage;
  final done = stdout.transform(utf8.decoder).transform(const LineSplitter()).forEach((line) {
    output.writeln(line);
    if (parseStageLine(line) case final step?) {
      stage = step.stage;
      onStage?.call(step.stage, step.maxSeconds);
    }
  });
  final waited = Stopwatch()..start();
  while (true) {
    final importing = importStages.contains(stage);
    final left = (importing ? wait.importing : wait.usual) - waited.elapsed;
    if (left <= Duration.zero) return (output: output.toString(), timedOut: true, importing: importing);
    try {
      await done.timeout(left);
      return (output: output.toString(), timedOut: false, importing: false);
    } on TimeoutException {
      // The step may have become an import meanwhile: its own wait decides.
    }
  }
}

/// A controller that is still importing when the window stops waiting: no
/// "did not answer", and nothing offered that would start a second import
/// (the strings word `import_running` with `timedOut`).
RuntimeReport stillImporting() => const RuntimeReport(RuntimeState.unknown,
    error: '导入仍在后台进行，完成前不要再点。 / The import is still running in the background; do not click again until it is done.',
    failure: StartupFailure('recovery_refused', {'code': 'recovery_refused', 'reason': 'import_running', 'timedOut': true}));

/// The controller action a recovery choice runs (src/desktop/desktop-controller.js), without its -preview / -start.
String recoveryAction({bool abandonImport = false, bool keepNewer = false}) =>
    abandonImport ? 'abandon-import' : keepNewer ? 'keep-newer' : 'recover';

/// A recovery plan as the CLI or a controller wrote it; null for anything else.
RecoveryPlan? parseRecoveryPlan(Object? value) => RecoveryPlan.parse(value is String ? _jsonObject(value) : value);

/// The step a line of a start's output reports (src/local-runtime/startup-stage.js
/// `readStartupMarker`), with the longest it will wait when the start said so.
/// The result line carries `ok`, so it is never one of these.
({String stage, int? maxSeconds})? parseStageLine(String line) {
  final value = _jsonObject(line);
  if (value == null || value.containsKey('ok')) return null;
  final stage = value['stage'];
  if (stage is! String || stage.isEmpty) return null;
  final max = value['maxSeconds'];
  return (stage: stage, maxSeconds: max is int ? max : null);
}

/// What a failed `fuli start` printed: its stderr without the reason line, and
/// the reason (src/local-runtime/startup-failure-line.js), when it gave one.
({String stderr, StartupFailure? failure}) readStartupFailure(String stderr) {
  const prefix = 'FULI_STARTUP_FAILURE ';
  StartupFailure? failure;
  final kept = <String>[];
  for (final line in const LineSplitter().convert(stderr)) {
    if (!line.startsWith(prefix)) {
      kept.add(line);
      continue;
    }
    try {
      failure = _failure(jsonDecode(line.substring(prefix.length)));
    } on FormatException {
      // A reason line that does not read leaves the message as it is.
    }
  }
  return (stderr: kept.join('\n'), failure: failure);
}

StartupFailure? _failure(Object? value, {String code = 'code'}) {
  if (value is! Map || value[code] is! String) return null;
  return StartupFailure(value[code] as String, Map<String, Object?>.from(value));
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
