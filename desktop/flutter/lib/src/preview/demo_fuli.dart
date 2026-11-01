import '../api/fuli_api.dart';
import '../api/migration_plan.dart';
import '../doctor/doctor_report.dart';
import '../runtime/fuli_runtime.dart';

// An in-memory FULI with synthetic data, for the web preview of the window and
// for widget tests. It answers like the console API and changes the way the
// real one would after a repair, a migration, an update, a start or a stop.

class DemoFuliApi implements FuliApi {
  DemoFuliApi({
    this.items = const [],
    this.installedVersion = '0.22.0',
    this.hasDoctor = true,
    this.latest,
    this.plan = const MigrationPlan(digest: null, stores: [], blocked: []),
  });

  List<DoctorItem> items;
  String installedVersion;
  bool hasDoctor;
  bool reachable = true;
  String? latest;
  MigrationPlan plan;
  List<AttentionNotice> attention = const [];
  final List<String> requests = [];
  final List<String> _updateSteps = ['downloading', 'verifying', 'installing'];
  int _updateRead = 0;

  void _call(String request) {
    requests.add(request);
    if (!reachable) throw const FuliUnreachable('connection refused');
  }

  @override
  Future<List<AttentionNotice>> openAttention() async {
    _call('attention');
    return attention;
  }

  @override
  Future<DoctorReport> doctor() async {
    _call('doctor');
    if (!hasDoctor) throw const FuliHttpError(404, message: 'Not found');
    final attention = items.any((item) => item.severity != DoctorSeverity.info);
    final blocking = items.any((item) => item.severity == DoctorSeverity.blocking);
    return DoctorReport(
      overall: blocking ? DoctorOverall.degraded : (attention ? DoctorOverall.needsPerson : DoctorOverall.ok),
      items: items,
      version: installedVersion,
    );
  }

  @override
  Future<RepairOutcome> repair() async {
    _call('repair');
    final fixed = items.where((item) => item.fix == DoctorFix.auto).length;
    items = items.where((item) => item.fix != DoctorFix.auto).toList();
    return RepairOutcome(fixed: fixed, failures: const []);
  }

  @override
  Future<HealthInfo> health() async {
    _call('health');
    return HealthInfo(ready: true, version: installedVersion);
  }

  @override
  Future<VersionInfo> version() async {
    _call('version');
    return VersionInfo(current: installedVersion, latest: latest, updateAvailable: latest != null);
  }

  @override
  Future<UpdateStatus> startUpdate() async {
    _call('startUpdate');
    _updateRead = 0;
    return const UpdateStatus(id: 'demo-update', state: UpdateState.updating);
  }

  @override
  Future<UpdateStatus?> readUpdate() async {
    _call('readUpdate');
    if (_updateRead < _updateSteps.length) {
      return UpdateStatus(id: 'demo-update', state: UpdateState.updating, step: _updateSteps[_updateRead++]);
    }
    installedVersion = latest ?? installedVersion;
    latest = null;
    items = items.where((item) => item.kind != 'update_available').toList();
    return UpdateStatus(id: 'demo-update', state: UpdateState.updated, version: installedVersion);
  }

  @override
  Future<MigrationPlan> migrationPlan() async {
    _call('migrationPlan');
    return plan;
  }

  @override
  Future<ApplyOutcome> applyMigration(String digest) async {
    _call('applyMigration:$digest');
    items = items.where((item) => item.kind != 'data_format_waiting').toList();
    plan = const MigrationPlan(digest: null, stores: [], blocked: []);
    return const ApplyOutcome(state: ApplyState.applied, failures: []);
  }
}

class DemoRuntime implements FuliRuntime {
  DemoRuntime(this.api, {this.installed = true, this.port = 2727, this.startTakes});

  final DemoFuliApi api;
  bool installed;
  final int port;
  // What a start waits for before FULI answers, as a real start takes a while.
  final Future<void> Function()? startTakes;

  RuntimeState get _state => !installed
      ? RuntimeState.notFound
      : (api.reachable ? RuntimeState.running : RuntimeState.stopped);

  @override
  Future<bool> locate() async => installed;

  @override
  Future<int> consolePort() async => port;

  @override
  Future<RuntimeReport> status() async => RuntimeReport(_state);

  @override
  Future<RuntimeReport> start() async {
    await startTakes?.call();
    api.reachable = true;
    return RuntimeReport(_state);
  }

  @override
  Future<RuntimeReport> stop() async {
    api.reachable = false;
    return RuntimeReport(_state);
  }

  @override
  bool get canChangePort => false;

  @override
  Future<RuntimeReport> changePort() async => RuntimeReport(_state);
}

/// The preview scenarios, by name (?state=… in the web preview).
(DemoFuliApi, DemoRuntime) demoScenario(String name, {Future<void> Function()? startTakes}) {
  final api = DemoFuliApi();
  final runtime = DemoRuntime(api, startTakes: startTakes);
  switch (name) {
    case 'ok':
      break;
    case 'stopped':
      api.reachable = false;
    case 'notfound':
      api.reachable = false;
      runtime.installed = false;
    case 'old':
      api.hasDoctor = false;
      api.latest = '0.23.0';
    case 'degraded':
      api.items = [
        const DoctorItem(id: 'format-blocked', kind: 'data_format_blocked', severity: DoctorSeverity.blocking,
            fix: DoctorFix.person, data: {'store': 'knowledge', 'label': 'Knowledge'}),
      ];
    default:
      api.latest = '0.23.0';
      api.items = demoItems;
      api.plan = demoPlan;
  }
  return (api, runtime);
}

const demoItems = [
  DoctorItem(id: 'client-codex', kind: 'client_outdated', severity: DoctorSeverity.warning, fix: DoctorFix.auto,
      data: {'clientId': 'codex', 'label': 'Codex', 'status': 'outdated'}),
  DoctorItem(id: 'format-tasks', kind: 'data_format_waiting', severity: DoctorSeverity.warning,
      fix: DoctorFix.person, data: {'store': 'tasks', 'label': 'Tasks', 'steps': ['tasks-v3']}),
  DoctorItem(id: 'sessions-claude', kind: 'sessions_outdated', severity: DoctorSeverity.warning,
      fix: DoctorFix.person, data: {'client': 'claude_code', 'count': 2, 'runningVersion': '0.21.0'}),
  DoctorItem(id: 'update', kind: 'update_available', severity: DoctorSeverity.info, fix: DoctorFix.person,
      data: {'latest': '0.23.0'}),
];

const demoPlan = MigrationPlan(
  digest: '3f1c2a9b7d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8',
  stores: [
    MigrationStore(
      label: 'Tasks',
      summary: 'Adds a status to every task.',
      fromVersion: 2,
      toVersion: 3,
      count: 42,
      sampleIds: ['task-0001', 'task-0002', 'task-0003'],
      undoAvailable: true,
    ),
  ],
  blocked: [],
);
