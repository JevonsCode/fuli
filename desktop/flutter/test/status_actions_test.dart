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

  // A start that stopped at a graph service of this data FULI lost track of offers one way on,
  // confirmed first (Jevons: no telling a person what to do without a way to do it).
  testWidgets('结束它并启动 appears after a start stopped at a lost graph service, and acts only once confirmed', (tester) async {
    final api = DemoFuliApi()..reachable = false;
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped));
    final controller = FuliController(apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    await tester.pumpWidget(FuliApp(brand: testBrand, services: AppServices(controller: controller, strings: zh, opener: RecordingOpener())));
    await controller.refresh();
    await tester.pump();
    expect(find.descendant(of: primary, matching: find.text('启动 FULI')), findsOneWidget);

    runtime.report = const RuntimeReport(RuntimeState.stopped,
        error: '本数据目录之前启动的图服务还在运行，占着端口 7687。', orphanedServices: [OrphanedService(7687, 'java')]);
    await tester.tap(find.text('启动 FULI'));
    await tester.pump();
    await tester.pump();
    final button = find.byKey(const Key('end-orphans-start'));
    expect(find.descendant(of: primary, matching: button), findsOneWidget);
    expect(find.descendant(of: button, matching: find.text('结束它并启动')), findsOneWidget);

    runtime.calls.clear();
    await tester.tap(button);
    await tester.pumpAndSettle();
    expect(find.textContaining('java（端口 7687）'), findsOneWidget, reason: 'the confirmation names what will be ended');
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(runtime.calls.where((call) => call != 'status'), isEmpty, reason: 'nothing happens without confirming');

    runtime.report = const RuntimeReport(RuntimeState.running);
    await tester.tap(button);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('end-orphans-confirm')));
    await tester.pump();
    await tester.pump();
    expect(runtime.calls.where((call) => call != 'status'), ['end-orphans-start']);
    expect(find.byKey(const Key('end-orphans-start')), findsNothing, reason: 'gone once FULI started');
  });
}
