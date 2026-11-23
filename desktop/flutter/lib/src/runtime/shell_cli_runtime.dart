import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'console_port.dart';
import 'fuli_runtime.dart';
import 'runtime_output.dart';

const _locateTimeout = Duration(seconds: 20);
const _commandTimeout = Duration(minutes: 10);
const _commandNotFound = 127;
const _errorTail = 400;

/// macOS and Linux: runs the `fuli` CLI through the person's login shell,
/// because an app started from Finder or the Dock does not get the PATH the
/// terminal has (Homebrew, npm prefixes, nvm).
class ShellCliRuntime implements FuliRuntime {
  ShellCliRuntime({required this.os, required this.env});

  final String os;
  final Map<String, String> env;
  // `-lc` reads the login profile; nvm and similar set PATH only in the
  // interactive rc file, so `-ilc` is tried when `-lc` finds no fuli.
  static const _shellModes = ['-lc', '-ilc'];
  String? _mode;

  String get _shell => env['SHELL']?.isNotEmpty == true ? env['SHELL']! : (os == 'macos' ? '/bin/zsh' : '/bin/sh');

  @override
  Future<bool> locate() async {
    if (_mode != null) return true;
    for (final mode in _shellModes) {
      final result = await _sh(mode, 'command -v fuli', _locateTimeout);
      if (result != null && result.exitCode == 0 && '${result.stdout}'.trim().isNotEmpty) {
        _mode = mode;
        return true;
      }
    }
    return false;
  }

  @override
  Future<int> consolePort() => readConsolePort(defaultDataDir(os: os, env: env));

  @override
  Future<String> logDirectory() async => '${defaultDataDir(os: os, env: env)}/logs';

  @override
  Future<RuntimeReport> status() async {
    if (!await locate()) return const RuntimeReport(RuntimeState.notFound);
    final result = await _sh(_mode!, 'fuli status --json', _commandTimeout);
    if (result == null) return const RuntimeReport(RuntimeState.unknown, error: 'fuli status did not answer.');
    if (result.exitCode == _commandNotFound) {
      _mode = null;
      return const RuntimeReport(RuntimeState.notFound);
    }
    return parseCliStatus('${result.stdout}');
  }

  @override
  Future<RuntimeReport> start({StageListener? onStage}) => _command('fuli start', onStage: onStage);

  @override
  Future<RuntimeReport> stop() => _command('fuli stop');

  // The CLI has no port change; on macOS a reserved port is not a known problem.
  @override
  bool get canChangePort => false;

  @override
  Future<RuntimeReport> changePort({StageListener? onStage}) async =>
      const RuntimeReport(RuntimeState.unknown, error: 'Changing the port needs the Windows tray controller.');

  @override
  Future<RuntimeReport> previewRecovery() async {
    if (!await locate()) return const RuntimeReport(RuntimeState.notFound);
    final result = await _sh(_mode!, 'fuli graph runtime recover --preview --json', _commandTimeout);
    final plan = parseRecoveryPlan('${result?.stdout ?? ''}'.trim().split('\n').last);
    return RuntimeReport(RuntimeState.stopped, recoveryPlan: plan,
        error: plan == null ? 'fuli graph runtime recover did not answer.' : null);
  }

  // The CLI's recovery with the confirmed plan's digest (it refuses a plan that changed), then a start.
  @override
  Future<RuntimeReport> recoverAndStart(String digest, {StageListener? onStage}) async {
    if (!await locate()) return const RuntimeReport(RuntimeState.notFound);
    if (!RegExp(r'^[0-9a-f]{16}$').hasMatch(digest)) return const RuntimeReport(RuntimeState.unknown, error: 'Not a recovery plan digest.');
    final recovered = await _sh(_mode!, 'fuli graph runtime recover --yes --expect $digest', _commandTimeout);
    if (recovered == null || recovered.exitCode != 0) {
      final after = await status();
      final printed = readStartupFailure('${recovered?.stderr ?? ''}');
      return RuntimeReport(after.state, consolePort: after.consolePort, failure: printed.failure,
          error: printed.stderr.trim().isEmpty ? 'fuli graph runtime recover did not finish.' : printed.stderr.trim());
    }
    return start(onStage: onStage);
  }

  // The CLI's own checked release (`fuli graph runtime unlock`), then a start.
  @override
  Future<RuntimeReport> releaseLockAndStart({StageListener? onStage}) async {
    if (!await locate()) return const RuntimeReport(RuntimeState.notFound);
    final released = await _sh(_mode!, 'fuli graph runtime unlock --yes', _commandTimeout);
    if (released == null || released.exitCode != 0) {
      final after = await status();
      // Why it kept the lock comes on its reason line (startup-failure-line.js) and is worded by this client.
      final printed = readStartupFailure('${released?.stderr ?? ''}');
      final kept = printed.failure;
      return RuntimeReport(after.state, consolePort: after.consolePort,
          error: printed.stderr.trim().isEmpty ? 'fuli graph runtime unlock did not finish.' : printed.stderr.trim(),
          lockKept: kept?.code == 'lock_kept' && kept?.text('reason') != null ? StartupFailure(kept!.text('reason')!, kept.facts) : null);
    }
    return start(onStage: onStage);
  }

  // `fuli start` and `fuli stop` print text, not JSON; the state afterwards
  // comes from `fuli status --json`. With [onStage] the CLI is asked for its
  // startup steps as machine-readable lines instead (startup-stage.js) and
  // they are read as they arrive.
  Future<RuntimeReport> _command(String command, {StageListener? onStage}) async {
    if (!await locate()) return const RuntimeReport(RuntimeState.notFound);
    final result = onStage == null
        ? await _sh(_mode!, command, _commandTimeout)
        : await _shFollowing(_mode!, command, _commandTimeout, onStage);
    final after = await status();
    if (result != null && result.exitCode == 0) return after;
    // The reason a start can name comes on a line of its own (startup-failure-line.js).
    final printed = readStartupFailure('${result?.stderr ?? ''}');
    final stderr = printed.stderr.trim();
    final error = stderr.isEmpty
        ? '$command did not finish.'
        : stderr.substring(stderr.length > _errorTail ? stderr.length - _errorTail : 0);
    return RuntimeReport(after.state, consolePort: after.consolePort, error: error, failure: printed.failure,
        autostartGaveUpAt: after.autostartGaveUpAt);
  }

  // Runs the command with FULI_STAGE_MARKERS set, so each startup step arrives
  // as its own line while the command is still running.
  Future<ProcessResult?> _shFollowing(String mode, String command, Duration timeout, StageListener onStage) async {
    try {
      final process = await Process.start(_shell, [mode, command],
          environment: {...env, ...stageMarkersEnvironment});
      final errors = StringBuffer();
      final reading = process.stderr.transform(utf8.decoder).forEach(errors.write);
      await process.stdout.transform(utf8.decoder).transform(const LineSplitter()).forEach((line) {
        if (parseStageLine(line) case final step?) onStage(step.stage, step.maxSeconds);
      }).timeout(timeout);
      await reading;
      return ProcessResult(process.pid, await process.exitCode.timeout(timeout), '', errors.toString());
    } on ProcessException {
      return null;
    } on TimeoutException {
      return null;
    }
  }

  Future<ProcessResult?> _sh(String mode, String command, Duration timeout) async {
    try {
      return await Process.run(_shell, [mode, command]).timeout(timeout);
    } on ProcessException {
      return null;
    } on TimeoutException {
      return null;
    }
  }
}
