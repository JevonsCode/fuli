// Start, stop and inspect FULI through its own entry points (the Windows tray
// controller, or the `fuli` CLI). This client never starts or stops FULI's
// processes itself.

enum RuntimeState { running, stopped, degraded, notConfigured, unknown, notFound }

class RuntimeReport {
  const RuntimeReport(this.state, {this.consolePort, this.error});

  final RuntimeState state;
  // The console port the runtime reported, when it did.
  final int? consolePort;
  final String? error;

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
}
