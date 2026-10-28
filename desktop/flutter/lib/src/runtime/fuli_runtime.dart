// Start, stop and inspect FULI through its own entry points (the Windows tray
// controller, or the `fuli` CLI). This client never starts or stops FULI's
// processes itself.

enum RuntimeState { running, stopped, degraded, notConfigured, unknown, notFound }

class RuntimeReport {
  const RuntimeReport(this.state, {this.consolePort, this.error, this.notice, this.portBlocked = false});

  final RuntimeState state;
  // The console port the runtime reported, when it did.
  final int? consolePort;
  final String? error;
  // What the person needs to know after a success (the port change names the new port).
  final String? notice;
  // A start failed on a console port Windows reserves; changing the port fixes it.
  final bool portBlocked;

  bool get running => state == RuntimeState.running || state == RuntimeState.degraded;
}

abstract interface class FuliRuntime {
  /// Whether a FULI installation this client can control was found.
  Future<bool> locate();

  /// The console port from the data directory's runtime settings (default 2727).
  Future<int> consolePort();

  Future<RuntimeReport> status();
  Future<RuntimeReport> start();
  Future<RuntimeReport> stop();

  /// Whether [changePort] exists here (the Windows tray controller's `change-port`).
  bool get canChangePort;

  /// Moves the console to a free port Windows does not reserve and restarts FULI.
  Future<RuntimeReport> changePort();
}
