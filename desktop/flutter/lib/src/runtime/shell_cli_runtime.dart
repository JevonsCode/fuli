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
// src/local-runtime/startup-stage.js: ask the CLI for its steps as lines.
const _stageMarkers = 'FULI_STAGE_MARKERS';

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
    final stderr = '${result?.stderr ?? ''}'.trim();
    final error = stderr.isEmpty
        ? '$command did not finish.'
        : stderr.substring(stderr.length > _errorTail ? stderr.length - _errorTail : 0);
    return RuntimeReport(after.state, consolePort: after.consolePort, error: error);
  }

  // Runs the command with FULI_STAGE_MARKERS set, so each startup step arrives
  // as its own line while the command is still running.
  Future<ProcessResult?> _shFollowing(String mode, String command, Duration timeout, StageListener onStage) async {
    try {
      final process = await Process.start(_shell, [mode, command],
          environment: {...env, _stageMarkers: '1'});
      final errors = StringBuffer();
      final reading = process.stderr.transform(utf8.decoder).forEach(errors.write);
      await process.stdout.transform(utf8.decoder).transform(const LineSplitter()).forEach((line) {
        final stage = parseStageLine(line);
        if (stage != null) onStage(stage);
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
