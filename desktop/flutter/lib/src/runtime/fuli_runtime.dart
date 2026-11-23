// Start, stop and inspect FULI through its own entry points (the Windows tray
// controller, the controller inside the macOS app, or the `fuli` CLI). This
// client never starts or stops FULI's processes itself.

enum RuntimeState { running, stopped, degraded, notConfigured, unknown, notFound }

/// A graph service of this installation's data that FULI lost track of when an
/// earlier start was interrupted, still holding one of its ports
/// (src/native-runtime/orphan-services.js): the port and the program's name.
class OrphanedService {
  const OrphanedService(this.port, this.command);

  final int port;
  final String? command;
}

class RuntimeReport {
  const RuntimeReport(this.state, {this.consolePort, this.error, this.notice, this.portBlocked = false, this.crashed = false, this.consoleStopped = false, this.orphanedServices = const []});

  final RuntimeState state;
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
  // A start stopped at graph services FULI lost track of; [FuliRuntime.endOrphansAndStart] ends them and starts.
  final List<OrphanedService> orphanedServices;

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

  /// Ends the graph services a failed start named ([RuntimeReport.orphanedServices]) and starts FULI:
  /// the controller's `end-orphans-start`, or `fuli start --end-orphaned-services`.
  Future<RuntimeReport> endOrphansAndStart();
}
