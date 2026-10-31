import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/fuli_api.dart';
import '../api/migration_plan.dart';
import '../doctor/doctor_report.dart';
import '../l10n/strings.dart';
import '../platform/ports.dart';
import '../runtime/fuli_runtime.dart';
import 'attention_watch.dart';
import 'fuli_condition.dart';
import 'notification_gate.dart';

const _visiblePoll = Duration(seconds: 15);
const _hiddenPoll = Duration(seconds: 120);
// Repeated connection failures stretch the poll up to this many times.
const _maxBackoff = 8;
// The console's own update page asks this often and gives up after this long.
const _updatePoll = Duration(seconds: 3);
const _updateGiveUp = Duration(minutes: 15);

/// How long to wait before the next check: 15 s while the window is visible,
/// 120 s while it is hidden, doubled for each repeated connection failure.
Duration pollDelay({required bool visible, required int failures}) {
  final base = visible ? _visiblePoll : _hiddenPoll;
  final factor = failures <= 1 ? 1 : (1 << (failures - 1)).clamp(1, _maxBackoff);
  return base * factor;
}

class Notice {
  const Notice(this.text, {this.error = false});
  final String text;
  final bool error;
}

typedef ApiFactory = FuliApi Function(int port);

/// The one state the window and the tray show: the latest check of FULI, the
/// operation running now (with a label from what it is really doing) and the
/// outcome of the last one.
class FuliController extends ChangeNotifier {
  FuliController({
    required this.apiFor,
    required this.runtime,
    required this.notifier,
    required this.strings,
    Future<void> Function(Duration) wait = Future.delayed,
    DateTime Function() now = DateTime.now,
  })  : _wait = wait,
        _now = now;

  final ApiFactory apiFor;
  final FuliRuntime runtime;
  final Notifier notifier;
  final Strings strings;
  final Future<void> Function(Duration) _wait;
  final DateTime Function() _now;
  final _gate = NotificationGate();
  final _attention = AttentionWatch();

  FuliSnapshot? _snapshot;
  String? _pending;
  Notice? _notice;
  bool _visible = true;
  bool _polling = false;
  // The person stopped FULI: being stopped is not news to them.
  bool _stoppedByPerson = false;
  int _failures = 0;
  // The port `fuli status` reported when it differs from the settings file.
  int? _runtimePort;
  Timer? _timer;
  Future<void>? _checking;
  // The start, stop or port change running now.
  Future<RuntimeReport>? _runtimeCall;
  bool _disposed = false;

  /// Null until the first check finished.
  FuliSnapshot? get snapshot => _snapshot;

  /// The label of the operation running now; one at a time.
  String? get pending => _pending;
  Notice? get notice => _notice;
  Uri get consoleUri => Uri.parse('http://127.0.0.1:${_snapshot?.port ?? 2727}/');

  FuliApi get _api => apiFor(_snapshot?.port ?? 2727);

  /// The port the console listens on: the one `fuli status` reported when it
  /// differs, else `ports.console` from the settings file.
  Future<int> consolePort() async => _runtimePort ?? await runtime.consolePort();

  /// Checks now and keeps checking on the poll schedule.
  void startPolling() {
    _polling = true;
    unawaited(refresh());
  }

  void setVisible(bool visible) {
    if (visible == _visible) return;
    _visible = visible;
    if (visible) {
      unawaited(refresh());
    } else {
      _schedule();
    }
  }

  Future<void> refresh() => _checking ??= _check().whenComplete(() => _checking = null);

  Future<void> _check() async {
    _timer?.cancel();
    final snapshot = await _inspect();
    if (_disposed) return;
    _show(snapshot);
    if (snapshot.reached && snapshot.running) await _announceAttention(apiFor(snapshot.port));
    _schedule();
  }

  // Each new request an Agent leaves for the person is one notification; a
  // burst becomes one. An older FULI without the route says nothing.
  Future<void> _announceAttention(FuliApi api) async {
    final List<AttentionNotice> open;
    try {
      open = await api.openAttention();
    } on Object {
      return;
    }
    final fresh = _attention.observe(open);
    if (_disposed || fresh.isEmpty) return;
    unawaited(fresh.length == 1
        ? notifier.notify(strings.attentionTitle, fresh.single.title)
        : notifier.notify(strings.attentionTitle, strings.attentionMany(fresh.length)));
  }

  void _show(FuliSnapshot snapshot) {
    _snapshot = snapshot;
    _failures = snapshot.reached ? 0 : _failures + 1;
    if (snapshot.condition != FuliCondition.notRunning) _stoppedByPerson = false;
    if (_gate.observe(snapshot.condition, quiet: _stoppedByPerson || _pending != null)) {
      unawaited(notifier.notify('FULI', snapshot.sentence(strings)));
    }
    notifyListeners();
  }

  void _schedule() {
    _timer?.cancel();
    if (!_polling || _disposed) return;
    _timer = Timer(pollDelay(visible: _visible, failures: _failures), () {
      // A running operation checks again when it ends.
      if (_pending == null) unawaited(refresh());
    });
  }

  Future<FuliSnapshot> _inspect({bool retried = false}) async {
    final installed = await runtime.locate();
    final port = await consolePort();
    final api = apiFor(port);
    try {
      final report = await api.doctor();
      return FuliSnapshot(
        condition: conditionOf(report.overall),
        port: port,
        installed: installed,
        running: true,
        items: report.items,
        version: report.version,
      );
    } on FuliHttpError catch (error) {
      if (error.status == 404) return _withoutDoctor(api, port, installed);
      return _consoleFailed(port, installed, '$error');
    } on FormatException catch (error) {
      return _consoleFailed(port, installed, error.message);
    } on FuliUnreachable {
      final report = installed ? await runtime.status() : const RuntimeReport(RuntimeState.notFound);
      final reported = report.consolePort;
      if (report.running && reported != null && reported != port && !retried) {
        _runtimePort = reported;
        return _inspect(retried: true);
      }
      if (!report.running) _runtimePort = null;
      return FuliSnapshot(
        condition: switch (report.state) {
          RuntimeState.notFound => FuliCondition.notFound,
          RuntimeState.running || RuntimeState.degraded => FuliCondition.degraded,
          _ => FuliCondition.notRunning,
        },
        port: port,
        installed: report.state != RuntimeState.notFound,
        running: report.running,
        problem: report.running ? strings.noAnswer : null,
        reached: false,
      );
    }
  }

  FuliSnapshot _consoleFailed(int port, bool installed, String detail) => FuliSnapshot(
        condition: FuliCondition.degraded,
        port: port,
        installed: installed,
        running: true,
        problem: strings.consoleError(detail),
      );

  // An older FULI without /api/system/doctor: health and version only.
  Future<FuliSnapshot> _withoutDoctor(FuliApi api, int port, bool installed) async {
    final HealthInfo health;
    try {
      health = await api.health();
    } on Exception catch (error) {
      return _consoleFailed(port, installed, '$error');
    }
    VersionInfo? version;
    try {
      version = await api.version();
    } on Exception {
      version = null;
    }
    final latest = version?.latest;
    return FuliSnapshot(
      condition: health.ready ? FuliCondition.ok : FuliCondition.degraded,
      port: port,
      installed: installed,
      running: true,
      doctorUnsupported: true,
      version: health.version ?? version?.current,
      items: [
        if (version != null && version.updateAvailable && latest != null)
          DoctorItem(
            id: 'update_available',
            kind: 'update_available',
            severity: DoctorSeverity.info,
            fix: DoctorFix.person,
            data: {'latest': latest},
          ),
      ],
    );
  }

  // Operations: one at a time, each ends with a fresh check.

  Future<void> repair() {
    final items = _snapshot?.autoItems ?? const [];
    if (items.isEmpty) return Future.value();
    return _operate(_repairLabel(items), () async => _notice = await _repairNotice());
  }

  Future<void> start() {
    _stoppedByPerson = false;
    return _operate(strings.starting, () async {
      final report = await _call(runtime.start);
      final error = report.error;
      if (error == null) return;
      _notice = Notice(report.portBlocked && runtime.canChangePort ? strings.startFailedPortBlocked(error) : strings.startFailed(error),
          error: true);
    });
  }

  Future<void> stop() {
    _stoppedByPerson = true;
    return _operate(strings.stopping, () async {
      final report = await _call(runtime.stop);
      if (report.error != null) _notice = Notice(strings.stopFailed(report.error!), error: true);
    });
  }

  /// Moves the console to a port Windows does not reserve and restarts FULI.
  Future<void> changePort() {
    if (!runtime.canChangePort) return Future.value();
    _stoppedByPerson = false;
    return _operate(strings.changingPort, () async {
      final report = await _call(runtime.changePort);
      // The settings file names the new port now.
      _runtimePort = null;
      final error = report.error;
      _notice = error != null ? Notice(strings.portChangeFailed(error), error: true) : Notice(report.notice ?? strings.portChanged);
    });
  }

  /// Completes once no start, stop or port change is running, so the client
  /// can exit for an update without leaving one half done.
  Future<void> runtimeIdle() async {
    final call = _runtimeCall;
    if (call != null) await call.then((_) {}, onError: (_) {});
  }

  Future<RuntimeReport> _call(Future<RuntimeReport> Function() action) => _runtimeCall = action();

  /// Starts the console's own update, follows its real steps and, once the
  /// new version answers, checks again and runs the automatic repairs.
  Future<void> update(String version) => _operate(strings.updateStep(null, version), () async {
        final api = _api;
        final started = await api.startUpdate();
        var latest = started;
        final deadline = _now().add(_updateGiveUp);
        while (latest.state == UpdateState.updating) {
          if (_now().isAfter(deadline)) {
            _notice = Notice(strings.updateNotBack, error: true);
            return;
          }
          await _wait(_updatePoll);
          final read = await _readUpdate(api);
          if (read == null || read.id != started.id) continue;
          latest = read;
          if (read.step != null) _setPending(strings.updateStep(read.step, version));
        }
        switch (latest.state) {
          case UpdateState.updated:
            final updated = strings.updated(latest.version ?? version);
            _notice = Notice(updated);
            _setPending(strings.checkingAfterUpdate);
            final after = await _inspect();
            _show(after);
            if (after.autoItems.isNotEmpty) {
              _setPending(_repairLabel(after.autoItems));
              final repaired = await _repairNotice();
              if (repaired != null) {
                _notice = Notice(strings.sentences(updated, repaired.text), error: repaired.error);
              }
            }
          case UpdateState.unchanged:
            _notice = Notice(strings.updateUnchanged);
          case UpdateState.failed:
            _notice = Notice(strings.updateFailed(latest.error ?? ''), error: true);
          case UpdateState.updating:
            break;
        }
      });

  Future<MigrationPlan> migrationPlan() => _api.migrationPlan();

  Future<ApplyOutcome> applyMigration(String digest) async {
    try {
      return await _api.applyMigration(digest);
    } finally {
      unawaited(refresh());
    }
  }

  // While FULI installs it does not answer; keep asking until it does.
  Future<UpdateStatus?> _readUpdate(FuliApi api) async {
    try {
      return await api.readUpdate();
    } on FuliUnreachable {
      return null;
    } on FuliHttpError {
      return null;
    }
  }

  Future<Notice?> _repairNotice() async {
    final outcome = await _api.repair();
    if (outcome.failures.isNotEmpty) {
      return Notice(strings.repairFailed(outcome.failures.length, outcome.failures.join('; ')), error: true);
    }
    return outcome.fixed > 0 ? Notice(strings.repaired(outcome.fixed)) : null;
  }

  String _repairLabel(List<DoctorItem> items) {
    if (items.length > 1) return strings.repairingMany(items.length);
    final item = items.single;
    return switch (item.kind) {
      'client_outdated' => strings.reconnecting(Strings.clientName(
          '${item.data['label'] ?? item.data['clientId'] ?? ''}')),
      'update_left_work' => strings.reconnectingAgents,
      _ => strings.repairingOne,
    };
  }

  Future<void> _operate(String label, Future<void> Function() body) async {
    if (_pending != null) return;
    _notice = null;
    _setPending(label);
    try {
      await body();
    } on Exception catch (error) {
      _notice = Notice(strings.actionFailed('$error'), error: true);
    } finally {
      _pending = null;
      if (!_disposed) notifyListeners();
    }
    if (_disposed) return;
    // A check that began before the operation ended may be stale.
    await _checking;
    await refresh();
  }

  void _setPending(String label) {
    _pending = label;
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}
