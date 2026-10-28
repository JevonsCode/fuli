import 'dart:async';
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
  Future<RuntimeReport> start() => _command('fuli start');

  @override
  Future<RuntimeReport> stop() => _command('fuli stop');

  // The CLI has no port change; on macOS a reserved port is not a known problem.
  @override
  bool get canChangePort => false;

  @override
  Future<RuntimeReport> changePort() async => const RuntimeReport(RuntimeState.unknown, error: 'Changing the port needs the Windows tray controller.');

  // `fuli start` and `fuli stop` print text, not JSON; the state afterwards
  // comes from `fuli status --json`.
  Future<RuntimeReport> _command(String command) async {
    if (!await locate()) return const RuntimeReport(RuntimeState.notFound);
    final result = await _sh(_mode!, command, _commandTimeout);
    final after = await status();
    if (result != null && result.exitCode == 0) return after;
    final stderr = '${result?.stderr ?? ''}'.trim();
    final error = stderr.isEmpty
        ? '$command did not finish.'
        : stderr.substring(stderr.length > _errorTail ? stderr.length - _errorTail : 0);
    return RuntimeReport(after.state, consolePort: after.consolePort, error: error);
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
