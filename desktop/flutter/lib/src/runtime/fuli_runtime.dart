// Start, stop and inspect FULI through its own entry points (the Windows tray
// controller, the controller inside the macOS app, or the `fuli` CLI). This
// client never starts or stops FULI's processes itself.

enum RuntimeState { running, stopped, degraded, notConfigured, unknown, notFound }

/// Told which step of a start is running now, as the start reports it
/// (src/local-runtime/startup-stage.js). The ids are that module's.
typedef StageListener = void Function(String stage);

/// Why a start did not finish, as the start reported it
/// (src/local-runtime/startup-failure.js): its code and the facts behind it.
/// The client words what happened and offers its own next step.
class StartupFailure {
  const StartupFailure(this.code, this.facts);

  final String code;
  final Map<String, Object?> facts;

  String? text(String key) => facts[key] is String ? facts[key] as String : null;
  int? number(String key) => facts[key] is int ? facts[key] as int : null;
}

class RuntimeReport {
  const RuntimeReport(this.state,
      {this.consolePort, this.error, this.notice, this.portBlocked = false, this.crashed = false, this.consoleStopped = false,
      this.stage, this.failure, this.autostartGaveUpAt});

  final RuntimeState state;
  /// The step that did not finish, when a failed start named one.
  final String? stage;
  /// What a failed start ran into, when it was one the start can name.
  final StartupFailure? failure;
  /// When client sessions stopped starting FULI by themselves, after repeated
  /// starts did not keep it running; null while they still would.
  final String? autostartGaveUpAt;
  // The console port the runtime reported, when it did.
  final int? consolePort;
  final String? error;
  // What the person needs to know after a success (the port change names the new port).
  final String? notice;
  // A start failed on a console port Windows reserves; changing the port fixes it.
  final bool portBlocked;
  // The console went away without anyone stopping it.
  final bool crashed;
  // No console process runs, whatever the graph does (rec issue 70).
  final bool consoleStopped;

  bool get running => state == RuntimeState.running || state == RuntimeState.degraded;
}

abstract interface class FuliRuntime {
  /// Whether a FULI installation this client can control was found.
  Future<bool> locate();

  /// The console port from the data directory's runtime settings (default 2727).
  Future<int> consolePort();

  /// The folder that holds the start's logs, for 「查看启动日志」.
  Future<String> logDirectory();

  Future<RuntimeReport> status();

  /// [onStage] is called with each step of the start as it begins, so the
  /// window says what FULI is doing instead of only that it is starting.
  Future<RuntimeReport> start({StageListener? onStage});
  Future<RuntimeReport> stop();

  /// Whether [changePort] exists here (the Windows tray controller's `change-port`).
  bool get canChangePort;

  /// Moves the console to a free port Windows does not reserve and restarts FULI.
  Future<RuntimeReport> changePort({StageListener? onStage});
}
