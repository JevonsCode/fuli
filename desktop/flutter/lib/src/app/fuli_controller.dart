import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/fuli_api.dart';
import '../api/glance.dart';
import '../api/migration_plan.dart';
import '../doctor/doctor_report.dart';
import '../l10n/strings.dart';
import '../platform/ports.dart';
import '../runtime/fuli_runtime.dart';
import '../runtime/provider_conflict.dart';
import 'attention_watch.dart';
import 'check_log.dart';
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
  const Notice(this.text, {this.error = false, this.logDirectory});
  final String text;
  final bool error;
  // A failed start's log folder: 「查看启动日志」 opens it, instead of a command to type.
  final String? logDirectory;
}

typedef ApiFactory = FuliApi Function(int port);

/// The one state the window and the tray show: the latest check of FULI, the
/// operation running now (with a label from what it is really doing) and the
/// outcome of the last one.
const maxRestarts = 3;
const restartWindow = Duration(minutes: 10);

class FuliController extends ChangeNotifier {
  FuliController({
    required this.apiFor,
    required this.runtime,
    required this.notifier,
    required this.strings,
    Future<void> Function(Duration) wait = Future.delayed,
    DateTime Function() now = DateTime.now,
    CheckLog checkLog = const SilentCheckLog(),
  })  : _wait = wait,
        _now = now,
        _checkLog = checkLog;

  final ApiFactory apiFor;
  final FuliRuntime runtime;
  final Notifier notifier;
  final Strings strings;
  final Future<void> Function(Duration) _wait;
  final DateTime Function() _now;
  final CheckLog _checkLog;
  final _gate = NotificationGate();
  final _attention = AttentionWatch();

  FuliSnapshot? _snapshot;
  Glance? _glance;
  int _waitingRequests = 0;
  String? _pending;
  // The label of a start or port change, kept until the check after it.
  String? _bringingUp;
  Notice? _notice;
  bool _visible = true;
  bool _polling = false;
  // The person stopped FULI: being stopped is not news to them.
  bool _stoppedByPerson = false;
  // The last check found FULI's graph running without a console process.
  bool _consoleDown = false;
  bool _startOnOpen = false;
  final _restarts = <DateTime>[];
  int _failures = 0;
  // The port `fuli status` reported when it differs from the settings file.
  int? _runtimePort;
  Timer? _timer;
  Future<void>? _checking;
  // The start, stop or port change running now.
  Future<RuntimeReport>? _runtimeCall;
  // The step of the start running now and when it began (startup-stage.js), so
  // the window says what FULI is doing and, when a step takes long, how long
  // it has waited. Nothing here is guessed: the start reports each step itself.
  String? _stage;
  int? _stageMaxSeconds;
  DateTime? _stageSince;
  // What the last start, restart, port change or release stopped at: its code
  // and facts, or null when it did not stop at a named cause. The one primary
  // action after a failed start comes from it (status_actions.dart).
  StartupFailure? _lastFailure;
  Timer? _stageTick;
  bool _disposed = false;

  /// How long a step runs before the window adds what it is waiting on.
  static const stageSlowAfter = Duration(seconds: 15);
  // The waited time is retold this often; a calmer beat than one second.
  static const _stageTickEvery = Duration(seconds: 5);

  /// Null until the first check finished.
  FuliSnapshot? get snapshot => _snapshot;

  /// The work the tray menu shows, as of the latest check; null while FULI
  /// does not answer or has no glance yet.
  Glance? get glance => _glance;

  /// How many requests Agents left for the person are open, up to
  /// [openAttentionLimit].
  int get waitingRequests => _waitingRequests;

  /// The label of the operation running now; one at a time.
  String? get pending => _pending;

  /// While a start or a port change runs, and until the check after it
  /// finishes, what is being done: the window waits for the console instead
  /// of showing the stopped FULI in between.
  String? get bringingUp => _bringingUp;

  /// The step of the start running now, as the start reported it; null when
  /// no start is running or it reported no step.
  String? get startupStage => _stage;

  /// The longest that step will wait, when the start reported its limit.
  int? get startupMaxSeconds => _stageMaxSeconds;

  /// Why the last start-like action stopped, when it named a cause.
  StartupFailure? get lastFailure => _lastFailure;

  /// Whether the last start stopped at a database maintenance lock that
  /// 「解除这把锁并启动」 may release after FULI's checks.
  bool get releasableLock => _lastFailure != null && strings.releasableLock(_lastFailure!);

  /// How long that step has been waiting; null when no step is running.
  Duration? get startupWaited {
    final since = _stageSince;
    return since == null ? null : _now().difference(since);
  }

  Notice? get notice => _notice;
  Uri get consoleUri => Uri.parse('http://127.0.0.1:${_snapshot?.port ?? 2727}/');

  FuliApi get _api => apiFor(_snapshot?.port ?? 2727);

  /// The port the console listens on: the one `fuli status` reported when it
  /// differs, else `ports.console` from the settings file.
  Future<int> consolePort() async => _runtimePort ?? await runtime.consolePort();

  /// Checks now and keeps checking on the poll schedule. [startFuli]: opening
  /// the client, at login too, means wanting FULI, so a first check that finds
  /// it stopped starts it. A start that fails stays on the page with its button.
  void startPolling({bool startFuli = false}) {
    _polling = true;
    _startOnOpen = startFuli;
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
    await _readWork(snapshot.reached && snapshot.running ? apiFor(snapshot.port) : null);
    _schedule();
    _startIfWanted(snapshot);
  }

  // Opening the client means wanting FULI; so does a stop nobody asked for,
  // though a FULI that keeps falling over is left to the person's button.
  void _startIfWanted(FuliSnapshot snapshot) {
    final opened = _startOnOpen;
    _startOnOpen = false;
    // The graph can run with no console process (a first open, a console that went away, rec issue 70):
    // starting brings the console up. A console that runs but answers slowly is left alone.
    final consoleDown = _consoleDown;
    if ((snapshot.condition != FuliCondition.notRunning && !consoleDown) || _pending != null) return;
    if (!opened) {
      if (!(snapshot.crashed || consoleDown) || _stoppedByPerson) return;
      final now = _now();
      _restarts.removeWhere((at) => now.difference(at) > restartWindow);
      if (_restarts.length >= maxRestarts) return;
      _restarts.add(now);
    }
    unawaited(start());
  }

  // What the tray menu shows besides FULI's condition: the open requests and
  // the glance, read from a FULI that answers ([api] null: it does not). Either
  // read that fails, an older FULI without the route included, shows nothing.
  Future<void> _readWork(FuliApi? api) async {
    final open = api == null ? null : await _announceAttention(api);
    Glance? glance;
    try {
      glance = await api?.glance();
    } on Object {
      glance = null;
    }
    if (_disposed) return;
    _waitingRequests = open ?? 0;
    _glance = glance;
    notifyListeners();
  }

  // Each new request an Agent leaves for the person is one notification; a
  // burst becomes one. Answers how many are open; an older FULI without the
  // route says nothing and answers null.
  Future<int?> _announceAttention(FuliApi api) async {
    final List<AttentionNotice> open;
    try {
      open = await api.openAttention();
    } on Object {
      return null;
    }
    final fresh = _attention.observe(open);
    if (_disposed || fresh.isEmpty) return open.length;
    unawaited(fresh.length == 1
        ? notifier.notify(strings.attentionTitle, fresh.single.title)
        : notifier.notify(strings.attentionTitle, strings.attentionMany(fresh.length)));
    return open.length;
  }

  void _show(FuliSnapshot snapshot) {
    _snapshot = snapshot;
    // FULI running without an answering console is checked on the normal
    // schedule: backing off would leave the page stale for minutes (11-03).
    _failures = snapshot.reached || snapshot.running ? 0 : _failures + 1;
    if (snapshot.condition != FuliCondition.notRunning) _stoppedByPerson = false;
    if (_gate.observe(snapshot.condition, quiet: _stoppedByPerson || _startOnOpen || _pending != null)) {
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
      _consoleDown = false;
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
      _checkLog.failed(_now(), 'http-${error.status}', '$error');
      return _consoleFailed(port, installed, '$error');
    } on FormatException catch (error) {
      _checkLog.failed(_now(), 'unreadable', error.message);
      return _consoleFailed(port, installed, error.message);
    } on FuliUnreachable catch (error) {
      final timedOut = error.reason == 'timeout';
      _checkLog.failed(_now(), timedOut ? 'doctor-timeout' : 'unreachable', error.reason);
      if (timedOut) {
        final answered = await _healthAfterSlowDoctor(api, port, installed);
        if (answered != null) return answered;
      }
      final report = installed ? await runtime.status() : const RuntimeReport(RuntimeState.notFound);
      final reported = report.consolePort;
      if (report.running && reported != null && reported != port && !retried) {
        _runtimePort = reported;
        return _inspect(retried: true);
      }
      if (!report.running) _runtimePort = null;
      _consoleDown = report.running && report.consoleStopped;
      return FuliSnapshot(
        condition: switch (report.state) {
          RuntimeState.notFound => FuliCondition.notFound,
          RuntimeState.running || RuntimeState.degraded => FuliCondition.degraded,
          _ => FuliCondition.notRunning,
        },
        port: port,
        installed: report.state != RuntimeState.notFound,
        running: report.running,
        problem: report.running
            ? strings.noAnswer
            : report.autostartGaveUpAt != null
                ? strings.autostartGaveUp(strings.clockOf(report.autostartGaveUpAt!))
                : null,
        reached: false,
        crashed: report.crashed,
      );
    }
  }

  // The doctor's checks can wait on the graph (a paused Neo4j, rec#70): a
  // doctor that times out while the health route answers at once is a slow
  // check, not a console that does not answer. The last answer stays shown.
  Future<FuliSnapshot?> _healthAfterSlowDoctor(FuliApi api, int port, bool installed) async {
    final HealthInfo health;
    try {
      health = await api.health();
    } on Exception catch (error) {
      _checkLog.failed(_now(), 'health', '$error');
      return null;
    }
    final last = _snapshot;
    if (last != null && last.reached && last.port == port) return last;
    return FuliSnapshot(
      condition: health.ready ? FuliCondition.ok : FuliCondition.degraded,
      port: port,
      installed: installed,
      running: true,
      version: health.version,
    );
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

  /// The person confirmed releasing the lock the last start stopped at: FULI
  /// checks that nothing uses it, releases it and starts (neo4j-lifecycle-lock.js).
  Future<void> releaseLockAndStart() {
    if (!releasableLock) return Future.value();
    _stoppedByPerson = false;
    return _bringUp(strings.starting, () async {
      final report = await _call(() => runtime.releaseLockAndStart(onStage: _enterStage));
      final kept = report.lockKept;
      _notice = kept != null ? Notice(strings.lockKept(kept), error: true) : await _startFailure(report) ?? _notice;
    });
  }

  Future<void> start() {
    _stoppedByPerson = false;
    return _bringUp(strings.starting, () async {
      final report = await _call(() => runtime.start(onStage: _enterStage));
      _notice = await _startFailure(report) ?? _notice;
    });
  }

  // Why a start did not work, in the person's words where the cause is known; null when it worked.
  Future<Notice?> _startFailure(RuntimeReport report) async {
    final error = report.error;
    final failure = report.failure;
    _lastFailure = error == null ? null : failure;
    if (error == null) return null;
    final because = failure == null ? null : strings.startFailedBecause(failure);
    if (because != null) return Notice(because, error: true, logDirectory: await runtime.logDirectory());
    final shown = ProviderConflict.parse(error)?.shown;
    // Which step did not finish, when the start named one: a failure in the
    // middle of a long start otherwise reads as if nothing had happened.
    final step = strings.startupStage(report.stage ?? _stage);
    return Notice(
        shown != null
            ? strings.startFailedNewerData(shown.installed, shown.current)
            : report.portBlocked && runtime.canChangePort
                ? strings.startFailedPortBlocked(error)
                : step != null
                    ? strings.startFailedAtStep(step, error)
                    : strings.startFailed(error),
        error: true,
        logDirectory: await runtime.logDirectory());
  }

  // The start says it has begun another step; the window follows it.
  void _enterStage(String stage, int? maxSeconds) {
    if (_disposed) return;
    _stage = stage;
    _stageMaxSeconds = maxSeconds;
    _stageSince = _now();
    _stageTick ??= Timer.periodic(_stageTickEvery, (_) {
      if (!_disposed && _stageSince != null) notifyListeners();
    });
    notifyListeners();
  }

  void _forgetStage() {
    _stage = null;
    _stageMaxSeconds = null;
    _stageSince = null;
    _stageTick?.cancel();
    _stageTick = null;
  }

  Future<void> stop() {
    _stoppedByPerson = true;
    return _operate(strings.stopping, () async {
      final report = await _call(runtime.stop);
      if (report.error != null) _notice = Notice(strings.stopFailed(report.error!), error: true);
    });
  }

  /// Forgets what earlier checks learned (the port `fuli status` reported,
  /// the backoff, the last outcome) and checks again now: the way out of a
  /// state that went stale, such as a console that no longer answers.
  Future<void> recheck() {
    if (_pending != null) return Future.value();
    _runtimePort = null;
    _failures = 0;
    _notice = null;
    if (!_disposed) notifyListeners();
    return refresh();
  }

  /// Stops FULI and starts it again: the fix when it runs but its console
  /// does not answer.
  Future<void> restart() {
    _stoppedByPerson = false;
    return _bringUp(strings.restarting, () async {
      final stopped = await _call(runtime.stop);
      final stopError = stopped.error;
      if (stopError != null) {
        _notice = Notice(strings.stopFailed(stopError), error: true);
        return;
      }
      _runtimePort = null;
      _notice = await _startFailure(await _call(() => runtime.start(onStage: _enterStage))) ?? _notice;
    });
  }

  /// Moves the console to a port Windows does not reserve and restarts FULI.
  Future<void> changePort() {
    if (!runtime.canChangePort) return Future.value();
    _stoppedByPerson = false;
    return _bringUp(strings.changingPort, () async {
      final report = await _call(() => runtime.changePort(onStage: _enterStage));
      _lastFailure = report.error == null ? null : report.failure;
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

  Future<void> _bringUp(String label, Future<void> Function() body) async {
    if (_pending != null) return;
    _bringingUp = label;
    try {
      await _operate(label, body);
    } finally {
      _bringingUp = null;
      _forgetStage();
      if (!_disposed) notifyListeners();
    }
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
      'data_dir_shared' => strings.restrictingDataDir,
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
    _stageTick?.cancel();
    super.dispose();
  }
}
