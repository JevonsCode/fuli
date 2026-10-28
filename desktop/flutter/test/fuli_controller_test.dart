import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/api/fuli_api.dart';
import 'package:fuli_desktop/src/app/fuli_condition.dart';
import 'package:fuli_desktop/src/app/fuli_controller.dart';
import 'package:fuli_desktop/src/doctor/doctor_report.dart';
import 'package:fuli_desktop/src/l10n/strings.dart';
import 'package:fuli_desktop/src/preview/demo_fuli.dart';
import 'package:fuli_desktop/src/runtime/fuli_runtime.dart';

import 'support/fakes.dart';

const zh = Strings(chinese: true);

const codexOutdated = DoctorItem(id: 'client-codex', kind: 'client_outdated', severity: DoctorSeverity.warning,
    fix: DoctorFix.auto, data: {'clientId': 'codex', 'label': 'Codex'});

void main() {
  late RecordingNotifier notifier;
  final waits = <Duration>[];

  setUp(() {
    notifier = RecordingNotifier();
    waits.clear();
  });

  FuliController controllerFor(DemoFuliApi api, FuliRuntime runtime, {List<int>? ports}) => FuliController(
        apiFor: (port) {
          ports?.add(port);
          return api;
        },
        runtime: runtime,
        notifier: notifier,
        strings: zh,
        wait: (duration) async => waits.add(duration),
      );

  test('reads the doctor at the port the runtime resolved', () async {
    final api = DemoFuliApi(items: [codexOutdated]);
    final ports = <int>[];
    final controller = controllerFor(api, FixedRuntime(const RuntimeReport(RuntimeState.running), port: 4123), ports: ports);
    await controller.refresh();

    expect(ports, [4123]);
    expect(controller.consoleUri.toString(), 'http://127.0.0.1:4123/');
    final snapshot = controller.snapshot!;
    expect(snapshot.condition, FuliCondition.needsPerson);
    expect(snapshot.autoItems.single.id, 'client-codex');
    expect(snapshot.version, '0.22.0');
  });

  test('falls back to health and version when this FULI has no doctor', () async {
    final api = DemoFuliApi(hasDoctor: false, latest: '0.23.0');
    final controller = controllerFor(api, FixedRuntime(const RuntimeReport(RuntimeState.running)));
    await controller.refresh();

    final snapshot = controller.snapshot!;
    expect(snapshot.condition, FuliCondition.ok);
    expect(snapshot.doctorUnsupported, isTrue);
    expect(snapshot.version, '0.22.0');
    expect(snapshot.items.single.kind, 'update_available');
    expect(snapshot.items.single.data['latest'], '0.23.0');
    expect(api.requests, ['doctor', 'health', 'version']);
  });

  test('an unreachable console is told apart by the runtime', () async {
    final api = DemoFuliApi()..reachable = false;
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped));
    final controller = controllerFor(api, runtime);

    await controller.refresh();
    expect(controller.snapshot!.condition, FuliCondition.notRunning);
    expect(controller.snapshot!.running, isFalse);

    runtime.report = const RuntimeReport(RuntimeState.running);
    await controller.refresh();
    expect(controller.snapshot!.condition, FuliCondition.degraded);
    expect(controller.snapshot!.problem, zh.noAnswer);

    runtime.report = const RuntimeReport(RuntimeState.notFound);
    await controller.refresh();
    expect(controller.snapshot!.condition, FuliCondition.notFound);
    expect(controller.snapshot!.installed, isFalse);
  });

  test('follows the port `fuli status` reports when the settings file names another', () async {
    final api = DemoFuliApi()..reachable = false;
    final ports = <int>[];
    final controller = controllerFor(api, FixedRuntime(const RuntimeReport(RuntimeState.running, consolePort: 4200)),
        ports: ports);
    await controller.refresh();
    expect(ports, [4100, 4200]);
  });

  test('notifies once when FULI stops by itself, not when the person stopped it', () async {
    final api = DemoFuliApi();
    final runtime = DemoRuntime(api);
    final controller = controllerFor(api, runtime);

    await controller.refresh();
    api.reachable = false;
    await controller.refresh();
    await controller.refresh();
    expect(notifier.bodies, ['FULI 没有运行']);

    await controller.start();
    expect(controller.snapshot!.condition, FuliCondition.ok);
    await controller.stop();
    expect(controller.snapshot!.condition, FuliCondition.notRunning);
    expect(notifier.bodies, hasLength(1));
  });

  test('repair shows what it does, then reports and checks again', () async {
    final api = DemoFuliApi(items: [codexOutdated]);
    final controller = controllerFor(api, DemoRuntime(api));
    await controller.refresh();

    final labels = <String?>[];
    controller.addListener(() => labels.add(controller.pending));
    await controller.repair();

    expect(labels, contains('正在重新接入 Codex…'));
    expect(controller.pending, isNull);
    expect(controller.notice!.text, '已修复 1 件事。');
    expect(controller.snapshot!.condition, FuliCondition.ok);
    expect(api.requests.where((request) => request == 'repair'), hasLength(1));
  });

  test('update follows the real steps, then checks and repairs automatically', () async {
    final api = DemoFuliApi(latest: '0.23.0', items: [
      codexOutdated,
      const DoctorItem(id: 'update', kind: 'update_available', severity: DoctorSeverity.info,
          fix: DoctorFix.person, data: {'latest': '0.23.0'}),
    ]);
    final controller = controllerFor(api, DemoRuntime(api));
    await controller.refresh();

    final labels = <String>[];
    controller.addListener(() {
      final label = controller.pending;
      if (label != null && (labels.isEmpty || labels.last != label)) labels.add(label);
    });
    await controller.update('0.23.0');

    expect(labels, [
      '正在更新到 v0.23.0…',
      '正在下载 v0.23.0 的安装包…',
      '正在校验 v0.23.0 的安装包…',
      '正在安装 v0.23.0，FULI 会停止并重新启动…',
      '正在检查更新后的 FULI…',
      '正在重新接入 Codex…',
    ]);
    expect(waits, everyElement(const Duration(seconds: 3)));
    expect(controller.snapshot!.version, '0.23.0');
    expect(controller.snapshot!.items, isEmpty);
    expect(controller.notice!.text, '已更新到 v0.23.0。已修复 1 件事。');
  });

  test('an operation that fails says why and keeps the window usable', () async {
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, error: 'port 4100 is in use'));
    final api = DemoFuliApi()..reachable = false;
    final controller = controllerFor(api, runtime);
    await controller.refresh();
    await controller.start();

    expect(runtime.calls, contains('start'));
    expect(controller.notice!.error, isTrue);
    expect(controller.notice!.text, '没有启动成功：port 4100 is in use');
    expect(controller.pending, isNull);
  });

  test('applying a migration sends the digest that was shown', () async {
    final api = DemoFuliApi(plan: demoPlan);
    final controller = controllerFor(api, DemoRuntime(api));
    await controller.refresh();
    final plan = await controller.migrationPlan();
    await controller.applyMigration(plan.digest!);
    expect(api.requests, contains('applyMigration:${demoPlan.digest}'));
  });

  test('polls every 15 s while visible, 120 s while hidden, backing off on failures', () {
    expect(pollDelay(visible: true, failures: 0), const Duration(seconds: 15));
    expect(pollDelay(visible: false, failures: 0), const Duration(seconds: 120));
    expect(pollDelay(visible: true, failures: 1), const Duration(seconds: 15));
    expect(pollDelay(visible: true, failures: 2), const Duration(seconds: 30));
    expect(pollDelay(visible: true, failures: 3), const Duration(seconds: 60));
    expect(pollDelay(visible: true, failures: 10), const Duration(seconds: 120));
    expect(pollDelay(visible: false, failures: 10), const Duration(minutes: 16));
  });

  test('a console error is shown as FULI not working, with its reason', () async {
    final controller = FuliController(
      apiFor: (_) => _FailingApi(),
      runtime: FixedRuntime(const RuntimeReport(RuntimeState.running)),
      notifier: notifier,
      strings: zh,
    );
    await controller.refresh();
    expect(controller.snapshot!.condition, FuliCondition.degraded);
    expect(controller.snapshot!.problem, '控制台回答出错：Data format waiting');
  });
}

class _FailingApi extends DemoFuliApi {
  @override
  Future<DoctorReport> doctor() async => throw const FuliHttpError(503, message: 'Data format waiting');
}
