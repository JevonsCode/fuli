import 'dart:async';

import 'package:flutter/material.dart' show OutlinedButton;
import 'package:flutter/services.dart' show SystemChannels;
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

  testWidgets('an unfinished import offers 查看命令 where 打开控制台 sits: the real commands, each to copy, and 启动 FULI stays', (tester) async {
    final api = DemoFuliApi()..reachable = false;
    const command = "fuli graph import --input '/fuli-data/backups/graph/before-import-1' --target-mode container --yes";
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, error: 'unfinished',
        failure: StartupFailure('graph_import_unfinished', {'mode': 'container', 'graphs': ['personal'], 'way': 'copy',
          'wayPath': '/fuli-data/backups/graph/before-import-1', 'command': command, 'abandonCommand': 'fuli graph abandon-import --target-mode container'})));
    final copied = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied.add((call.arguments as Map)['text'] as String);
      return null;
    });
    final controller = FuliController(apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    await tester.pumpWidget(FuliApp(brand: testBrand, services: AppServices(controller: controller, strings: zh, opener: RecordingOpener())));
    await controller.refresh();
    await tester.pump();
    final place = tester.getRect(openConsole);
    await controller.start();
    await tester.pump();
    final show = find.byKey(const Key('unfinished-import-commands'));
    expect(find.descendant(of: show, matching: find.text('查看命令')), findsOneWidget);
    expect(tester.getRect(show).left, place.left);
    expect(find.descendant(of: primary, matching: find.text('启动 FULI')), findsOneWidget);
    await tester.tap(show);
    await tester.pumpAndSettle();
    expect(find.text('在终端里运行'), findsOneWidget);
    expect(find.byKey(const ValueKey('unfinished-import-command 0')), findsOneWidget);
    expect(find.text(command), findsOneWidget);
    expect(find.text('fuli graph abandon-import --target-mode container'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('copy-unfinished-import-command 1')));
    await tester.tap(find.byKey(const ValueKey('copy-unfinished-import-command 0')));
    expect(copied, ['fuli graph abandon-import --target-mode container', command]);
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
    expect(find.textContaining('已经生效；先确认它能启动'), findsOneWidget);
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
        'operation': 'update', 'fromVersion': '5.26.0', 'toVersion': '5.26.28', 'keepable': false,
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
    expect(find.text('完成更新，改用 5.26.28 并启动'), findsOneWidget);
    expect(find.text('取消更新，留在 5.26.0 并启动'), findsOneWidget);
    expect(find.textContaining('也可以取消更新、留在 5.26.0'), findsOneWidget);
    expect(find.byKey(const Key('keep-newer')), findsNothing, reason: 'cancelling the update is still possible, so finishing without a start check is not offered');
    await tester.tap(find.byKey(const Key('recover-alternative')));
    await tester.pumpAndSettle();
    expect(runtime.calls, contains('recover-start fedcba9876543210'));
    expect(controller.notice?.text, contains('/x/native-runtime/recovered/recovery-1.json'), reason: 'the record is pointed to');
  });

  testWidgets('an import whose copy cannot be used offers 放弃这次导入… instead: its own words and button, nothing without the confirmation', (tester) async {
    final api = DemoFuliApi()..reachable = false;
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, error: 'lock',
        failure: StartupFailure('native_lifecycle_lock', {'holder': 'gone', 'operation': 'load'})))
      ..recoveryPlan = const RecoveryPlan('refused', [], null, {'kind': 'refused', 'reason': 'restore_point_damaged', 'why': 'missing', 'backupPath': '/x/b'});
    final controller = FuliController(apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    await tester.pumpWidget(FuliApp(brand: testBrand, services: AppServices(controller: controller, strings: zh, opener: RecordingOpener())));
    await controller.refresh();
    await controller.start();
    await tester.pump();
    await tester.tap(find.byKey(const Key('recover-start')));
    await tester.pumpAndSettle();
    expect(controller.notice?.text, contains('找不到了'));
    final abandon = find.byKey(const Key('abandon-import'));
    expect(find.descendant(of: primary, matching: abandon), findsOneWidget);
    expect(tester.widget(abandon), isA<OutlinedButton>(), reason: 'the entry is a secondary button; the red one is in the confirmation');
    expect(find.byKey(const Key('recover-start')), findsNothing);

    runtime.recoveryPlan = const RecoveryPlan('abandon_load', [{'do': 'move-aside', 'path': '/x/native-runtime/personal/data/databases/neo4j', 'bytes': 1024}, {'do': 'release-lock'}],
        'aaaaaaaaaaaaaaaa', {'copyProblem': 'missing', 'backupPath': '/x/b', 'instances': ['personal'], 'written': ['personal'], 'dataDir': '/x', 'copies': []});
    await tester.tap(abandon);
    await tester.pumpAndSettle();
    expect(runtime.calls, contains('abandon-import-preview'));
    expect(find.textContaining('个人图谱：看文件的修改时间，导入开始后它的库被写过'), findsOneWidget);
    expect(find.textContaining('没有可以导回的导入前副本'), findsOneWidget);
    expect(find.text('放弃导入，清空这些图谱'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(runtime.calls.where((call) => call.startsWith('abandon-import-start')), isEmpty);
    await tester.tap(abandon);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('abandon-import-confirm')));
    await tester.pumpAndSettle();
    expect(runtime.calls, contains('abandon-import-start aaaaaaaaaaaaaaaa'));
  });

  testWidgets('a switch that neither finished nor went back offers keeping the newer version, confirmed on its own; moved graph data is shown after', (tester) async {
    final api = DemoFuliApi()..reachable = false;
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, error: 'refused',
        failure: StartupFailure('recovery_refused', {'reason': 'start_failed', 'planKind': 'finish_switch', 'alternativeRefused': 'no_fingerprint',
          'operation': 'update', 'fromVersion': '5.26.0', 'toVersion': '5.26.28', 'keepable': true, 'backupPath': '/x/before-neo4j', 'startFailure': {'message': 'no answer'}})))
      ..recoveryPlan = const RecoveryPlan('finish_switch', [{'do': 'release-lock'}], '0123456789abcdef',
          {'alternativeRefused': 'no_fingerprint', 'operation': 'update', 'fromVersion': '5.26.0', 'toVersion': '5.26.28', 'keepable': true})
      ..recoverReport = const RuntimeReport(RuntimeState.stopped, keptGraphData: [{'path': '/x/recovered/t', 'bytes': 2048, 'instances': ['workspace'],
        'stores': [{'from': '/x/recovered/t/workspace/data/databases/neo4j', 'to': '/x/workspace/data/databases/neo4j'}]}]);
    final controller = FuliController(apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    await tester.pumpWidget(FuliApp(brand: testBrand, services: AppServices(controller: controller, strings: zh, opener: RecordingOpener())));
    await controller.refresh();
    await controller.start();
    await tester.pump();
    await tester.tap(find.byKey(const Key('recover-start')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('recover-alternative')), findsNothing, reason: 'going back is not there');
    final keep = find.byKey(const Key('keep-newer'));
    expect(tester.widget(keep), isA<OutlinedButton>());
    expect(find.text('完成更新并解除这把锁…'), findsOneWidget);
    runtime.recoveryPlan = const RecoveryPlan('keep_newer', [{'do': 'archive-journal'}, {'do': 'release-lock'}], 'bbbbbbbbbbbbbbbb',
        {'operation': 'update', 'fromVersion': '5.26.0', 'toVersion': '5.26.28', 'backupPath': '/x/before-neo4j'});
    await tester.tap(keep);
    await tester.pumpAndSettle();
    expect(runtime.calls, contains('keep-newer-preview'));
    expect(find.textContaining("fuli graph import --input '/x/before-neo4j' --yes"), findsOneWidget);
    expect(find.text('完成更新，留在 5.26.28，并解除这把锁？'), findsOneWidget);
    expect(find.textContaining('不能再取消这次更新回到 5.26.0'), findsOneWidget);
    expect(find.textContaining('没能启动或没有应答'), findsNWidgets(2), reason: 'why it does not start comes first in the confirmation too');
    expect(runtime.calls.where((call) => call.startsWith('keep-newer-start')), isEmpty);
    await tester.tap(find.byKey(const Key('keep-newer-confirm')));
    await tester.pumpAndSettle();
    expect(runtime.calls, contains('keep-newer-start bbbbbbbbbbbbbbbb'));
  });

  testWidgets('a good copy that would not go back offers abandoning the import beside trying again', (tester) async {
    final api = DemoFuliApi()..reachable = false;
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, error: 'refused',
        failure: StartupFailure('recovery_refused', {'reason': 'restore_failed', 'detail': 'No space left on device', 'backupPath': '/x/b'})))
      ..recoveryPlan = const RecoveryPlan('restore_load', [{'do': 'restore', 'from': '/x/b', 'instances': ['personal']}, {'do': 'release-lock'}],
          '0123456789abcdef', {'restoreFailed': {'detail': 'No space left on device', 'freeBytes': 1024, 'leastBytes': 4096}});
    final controller = FuliController(apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    await tester.pumpWidget(FuliApp(brand: testBrand, services: AppServices(controller: controller, strings: zh, opener: RecordingOpener())));
    await controller.refresh();
    await controller.start();
    await tester.pump();
    expect(find.descendant(of: primary, matching: find.byKey(const Key('recover-start'))), findsOneWidget, reason: 'trying again stays the primary way');
    await tester.tap(find.byKey(const Key('recover-start')));
    await tester.pumpAndSettle();
    expect(find.textContaining('上次导回没有成功：No space left on device。磁盘剩余 1.0 KB'), findsOneWidget);
    runtime.recoveryPlan = const RecoveryPlan('abandon_load', [{'do': 'release-lock'}], 'aaaaaaaaaaaaaaaa',
        {'copyProblem': 'restore_failed', 'backupPath': '/x/b', 'dataDir': '/x', 'halfWritten': ['personal'], 'copies': []});
    await tester.tap(find.byKey(const Key('abandon-import')));
    await tester.pumpAndSettle();
    expect(runtime.calls, contains('abandon-import-preview'));
    expect(find.textContaining('副本是好的（校验和对得上）：/x/b'), findsOneWidget);
    await tester.tap(find.byKey(const Key('abandon-import-confirm')));
    await tester.pumpAndSettle();
    expect(runtime.calls, contains('abandon-import-start aaaaaaaaaaaaaaaa'));
  });

  testWidgets('a graph database of this data directory that held the store is ended by the recovery\'s own button, named for it', (tester) async {
    final api = DemoFuliApi()..reachable = false;
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, error: 'refused',
        failure: StartupFailure('recovery_refused', {'reason': 'restore_failed', 'detail': 'store is locked', 'backupPath': '/x/b',
          'holders': [{'pid': 77, 'name': 'java', 'own': true}]})))
      ..recoveryPlan = const RecoveryPlan('restore_load', [{'do': 'end-holders', 'processes': [{'pid': 77, 'name': 'java'}]},
        {'do': 'restore', 'from': '/x/b', 'instances': ['personal']}, {'do': 'release-lock'}], '0123456789abcdef', {});
    final controller = FuliController(apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    await tester.pumpWidget(FuliApp(brand: testBrand, services: AppServices(controller: controller, strings: zh, opener: RecordingOpener())));
    await controller.refresh();
    await controller.start();
    await tester.pump();
    expect(find.textContaining('恢复会先结束它再导回'), findsOneWidget);
    await tester.tap(find.byKey(const Key('recover-start')));
    await tester.pumpAndSettle();
    expect(find.textContaining('结束占着库的进程 77（java）'), findsOneWidget);
    expect(find.descendant(of: find.byKey(const Key('recover-confirm')), matching: find.text('结束它并重试导回')), findsOneWidget);
    await tester.tap(find.byKey(const Key('recover-confirm')));
    await tester.pumpAndSettle();
    expect(runtime.calls, contains('recover-start 0123456789abcdef'));
  });

  testWidgets('after a recovery that left graph data in the recovered folder, the window says where it is and how to move it back', (tester) async {
    final api = DemoFuliApi()..reachable = false;
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, error: 'switch',
        failure: StartupFailure('native_lifecycle_lock', {'holder': 'gone', 'operation': 'load'})))
      ..recoveryPlan = const RecoveryPlan('restore_load', [{'do': 'release-lock'}], '0123456789abcdef', {})
      ..recoverReport = const RuntimeReport(RuntimeState.running, consolePort: 2727, keptGraphData: [{'path': '/x/recovered/t', 'bytes': 2048,
        'instances': ['workspace'], 'stores': [{'from': '/x/recovered/t/workspace/data/databases/neo4j', 'to': '/x/workspace/data/databases/neo4j'}]}]);
    final controller = FuliController(apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    await tester.pumpWidget(FuliApp(brand: testBrand, services: AppServices(controller: controller, strings: zh, opener: RecordingOpener())));
    await controller.refresh();
    await controller.start();
    await tester.pump();
    await tester.tap(find.byKey(const Key('recover-start')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('recover-confirm')));
    await tester.pumpAndSettle();
    expect(find.text('挪开的图谱数据还在'), findsOneWidget);
    expect(find.textContaining("mv '/x/recovered/t/workspace/data/databases/neo4j' '/x/workspace/data/databases/neo4j'"), findsOneWidget);
  });

  testWidgets('a window running the fuli CLI shows the plan with the terminal command, and no button that would do nothing', (tester) async {
    final api = DemoFuliApi()..reachable = false;
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, error: 'switch',
        failure: StartupFailure('native_recovery_needed', {'operation': 'update', 'phase': 'switching'})))
      ..recoversInTerminal = true
      ..recoveryPlan = const RecoveryPlan('finish_switch', [{'do': 'release-lock'}], '0123456789abcdef', {
        'alternative': {'kind': 'back_out_switch', 'steps': [{'do': 'release-lock'}], 'digest': 'fedcba9876543210'},
      });
    final controller = FuliController(apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    await tester.pumpWidget(FuliApp(brand: testBrand, services: AppServices(controller: controller, strings: zh, opener: RecordingOpener())));
    await controller.refresh();
    await controller.start();
    await tester.pump();
    await tester.tap(find.byKey(const Key('recover-start')));
    await tester.pumpAndSettle();
    expect(find.text('在终端里完成'), findsOneWidget);
    expect(find.byKey(const ValueKey('recovery-command fuli graph runtime recover')), findsOneWidget);
    expect(find.byKey(const ValueKey('recovery-command fuli graph runtime recover --back-out')), findsOneWidget);
    expect(find.byKey(const Key('copy-recovery-command')), findsOneWidget);
    expect(find.byKey(const Key('recover-confirm')), findsNothing);
    expect(find.byKey(const Key('recover-alternative')), findsNothing);
    await tester.tap(find.text('关闭'));
    await tester.pumpAndSettle();
    expect(runtime.calls.where((call) => call.startsWith('recover-start')), isEmpty);
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
        error: '本数据目录之前启动的图服务还在运行，占着端口 7687。',
        failure: StartupFailure('orphaned_graph_service', {
          'code': 'orphaned_graph_service',
          'services': [
            {'port': 7687, 'command': 'java'}
          ]
        }));
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
