import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/app/app_services.dart';
import 'package:fuli_desktop/src/app/fuli_controller.dart';
import 'package:fuli_desktop/src/l10n/strings.dart';
import 'package:fuli_desktop/src/preview/demo_fuli.dart';
import 'package:fuli_desktop/src/runtime/fuli_runtime.dart';
import 'package:fuli_desktop/src/ui/fuli_app.dart';

import 'support/brand.dart';
import 'support/fakes.dart';

const zh = Strings(chinese: true);

void main() {
  final openConsole = find.byKey(const Key('open-console'));
  final primary = find.byKey(const Key('primary-action'));

  testWidgets('a start that failed offers 查看启动日志 where 打开控制台 sits, and it opens the log folder', (tester) async {
    final api = DemoFuliApi()..reachable = false;
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, error: 'no answer',
        failure: StartupFailure('console_not_answering', {'seconds': 60})));
    final opener = RecordingOpener();
    final controller = FuliController(apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    await tester.pumpWidget(FuliApp(brand: testBrand, services: AppServices(controller: controller, strings: zh, opener: opener)));
    await controller.refresh();
    await tester.pump();
    final place = tester.getRect(openConsole);
    await controller.start();
    await tester.pump();
    expect(find.textContaining('没有启动：控制台 60 秒内没有应答'), findsOneWidget);
    final action = find.byKey(const Key('notice-action'));
    expect(find.descendant(of: action, matching: find.text('查看启动日志')), findsOneWidget);
    // It takes the left slot; the start button keeps its place.
    expect(tester.getRect(action).left, place.left);
    expect(find.descendant(of: primary, matching: find.text('启动 FULI')), findsOneWidget);
    await tester.tap(action);
    expect(opener.opened.single.toFilePath(), '/fuli-data/logs/');
  });

  testWidgets('a lock nobody holds puts 解除这把锁并启动 in the primary place, and nothing happens without the confirmation',
      (tester) async {
    final api = DemoFuliApi()..reachable = false;
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, error: 'lock',
        failure: StartupFailure('native_lifecycle_lock', {'since': '2026-11-22T17:24:35.000Z', 'holder': 'unknown'})));
    final controller = FuliController(apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    await tester.pumpWidget(FuliApp(brand: testBrand, services: AppServices(controller: controller, strings: zh, opener: RecordingOpener())));
    await controller.refresh();
    await controller.start();
    await tester.pump();
    final release = find.byKey(const Key('release-lock-start'));
    expect(find.descendant(of: primary, matching: release), findsOneWidget);

    await tester.tap(release);
    await tester.pumpAndSettle();
    expect(find.text('解除数据库维护锁？'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(runtime.calls, isNot(contains('release-lock-start')));

    await tester.tap(release);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('release-lock-confirm')));
    await tester.pumpAndSettle();
    expect(runtime.calls, contains('release-lock-start'));
  });

  testWidgets('an interrupted database operation offers 恢复并启动: the plan first, nothing without the confirmation', (tester) async {
    final api = DemoFuliApi()..reachable = false;
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, error: 'switch',
        failure: StartupFailure('native_recovery_needed', {'operation': 'update', 'phase': 'switching'})))
      ..recoveryPlan = const RecoveryPlan('finish_switch', [{'do': 'archive-journal'}, {'do': 'release-lock'}], '0123456789abcdef', {});
    final controller = FuliController(apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    await tester.pumpWidget(FuliApp(brand: testBrand, services: AppServices(controller: controller, strings: zh, opener: RecordingOpener())));
    await controller.refresh();
    await controller.start();
    await tester.pump();
    final recover = find.byKey(const Key('recover-start'));
    expect(find.descendant(of: primary, matching: recover), findsOneWidget);
    expect(find.byKey(const Key('release-lock-start')), findsNothing);

    await tester.tap(recover);
    await tester.pumpAndSettle();
    expect(find.textContaining('已经生效：先确认它能启动'), findsOneWidget);
    expect(find.textContaining('· 解除数据库维护锁'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(runtime.calls.where((call) => call.startsWith('recover-start')), isEmpty);

    await tester.tap(recover);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('recover-confirm')));
    await tester.pumpAndSettle();
    expect(runtime.calls, contains('recover-start 0123456789abcdef'));
  });

  testWidgets('a switch that can also be backed out offers both, and recovers with the one chosen', (tester) async {
    final api = DemoFuliApi()..reachable = false;
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, error: 'switch',
        failure: StartupFailure('native_recovery_needed', {'operation': 'update', 'phase': 'switching'})))
      ..recoveryPlan = const RecoveryPlan('finish_switch', [{'do': 'release-lock'}], '0123456789abcdef', {
        'fromVersion': '5.26.0', 'toVersion': '5.26.28',
        'alternative': {'kind': 'back_out_switch', 'steps': [{'do': 'release-lock'}], 'digest': 'fedcba9876543210'},
      })
      ..recoverReport = const RuntimeReport(RuntimeState.running, consolePort: 2727, recoveryRecord: '/x/native-runtime/recovered/recovery-1.json');
    final controller = FuliController(apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    await tester.pumpWidget(FuliApp(brand: testBrand, services: AppServices(controller: controller, strings: zh, opener: RecordingOpener())));
    await controller.refresh();
    await controller.start();
    await tester.pump();
    await tester.tap(find.byKey(const Key('recover-start')));
    await tester.pumpAndSettle();
    expect(find.text('保留 5.26.28 并启动'), findsOneWidget);
    expect(find.textContaining('也可以撤回到切换前的 5.26.0'), findsOneWidget);
    await tester.tap(find.byKey(const Key('recover-alternative')));
    await tester.pumpAndSettle();
    expect(runtime.calls, contains('recover-start fedcba9876543210'));
    expect(controller.notice?.text, contains('/x/native-runtime/recovered/recovery-1.json'), reason: 'the record is pointed to');
  });

  testWidgets('打开控制台 and 启动 / 停止 keep their places while work runs, ends, stops and starts', (tester) async {
    final updateStep = Completer<void>();
    final (api, runtime) = demoScenario('needs');
    final controller = FuliController(
        apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh, wait: (_) => updateStep.future);
    await tester.pumpWidget(FuliApp(brand: testBrand, services: AppServices(controller: controller, strings: zh, opener: RecordingOpener())));
    await controller.refresh();
    await tester.pump();
    Rect at(Finder finder) => tester.getRect(finder);
    final places = (at(openConsole), at(primary));
    final review = at(find.text('查看并确认'));
    expect(find.descendant(of: primary, matching: find.text('停止 FULI')), findsOneWidget);

    // What runs now shows between the two buttons; neither they nor the cards move.
    await tester.tap(find.text('更新到 v0.23.0'));
    await tester.pump();
    expect(find.text('正在更新到 v0.23.0…'), findsOneWidget);
    expect((at(openConsole), at(primary)), places);
    expect(at(find.text('查看并确认')), review);

    updateStep.complete();
    for (var frame = 0; frame < 20 && controller.pending != null; frame++) {
      await tester.pump();
    }
    await tester.pump();
    expect(find.textContaining('已更新到 v0.23.0。'), findsOneWidget);
    expect((at(openConsole), at(primary)), places);

    await tester.tap(find.text('停止 FULI'));
    await tester.pump();
    await tester.pump();
    expect(find.descendant(of: primary, matching: find.text('启动 FULI')), findsOneWidget);
    expect((at(openConsole), at(primary)), places);

    await tester.tap(find.text('启动 FULI'));
    await tester.pump();
    await tester.pump();
    expect(find.descendant(of: primary, matching: find.text('停止 FULI')), findsOneWidget);
    expect((at(openConsole), at(primary)), places);
  });

  testWidgets('a running FULI whose console does not answer offers 重新检查 and 重启 FULI', (tester) async {
    final api = DemoFuliApi()..reachable = false;
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.running));
    final controller = FuliController(apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    await tester.pumpWidget(FuliApp(brand: testBrand, services: AppServices(controller: controller, strings: zh, opener: RecordingOpener())));
    await controller.refresh();
    await tester.pump();
    expect(find.descendant(of: primary, matching: find.text('重启 FULI')), findsOneWidget);
    expect(find.byKey(const Key('recheck')), findsOneWidget);

    runtime.calls.clear();
    await tester.tap(find.text('重启 FULI'));
    await tester.pump();
    await tester.pump();
    expect(runtime.calls.where((call) => call != 'status'), ['stop', 'start']);
  });

  testWidgets('without FULI the primary place opens the install page', (tester) async {
    final (api, runtime) = demoScenario('notfound');
    final controller = FuliController(apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    await tester.pumpWidget(FuliApp(brand: testBrand, services: AppServices(controller: controller, strings: zh, opener: RecordingOpener())));
    await controller.refresh();
    await tester.pump();
    expect(find.descendant(of: primary, matching: find.text('打开安装页')), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const Key('status-sentence'))).data, '没有找到 FULI');
  });
}
