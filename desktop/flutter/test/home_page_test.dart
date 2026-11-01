import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/app/app_services.dart';
import 'package:fuli_desktop/src/app/fuli_controller.dart';
import 'package:fuli_desktop/src/l10n/strings.dart';
import 'package:fuli_desktop/src/preview/demo_fuli.dart';
import 'package:fuli_desktop/src/ui/fuli_app.dart';
import 'package:fuli_desktop/src/ui/item_card.dart';
import 'package:fuli_desktop/src/ui/status_actions.dart';

import 'support/brand.dart';
import 'support/fakes.dart';

const zh = Strings(chinese: true);

void main() {
  late RecordingOpener opener;

  Future<(DemoFuliApi, FuliController)> showScenario(WidgetTester tester, String name,
      {Widget Function(Uri, VoidCallback)? consoleView}) async {
    opener = RecordingOpener();
    final (api, runtime) = demoScenario(name);
    final controller = FuliController(
      apiFor: (_) => api,
      runtime: runtime,
      notifier: RecordingNotifier(),
      strings: zh,
      wait: (_) async {},
    );
    await tester.pumpWidget(FuliApp(brand: testBrand, services: AppServices(controller: controller, strings: zh, opener: opener, consoleView: consoleView)));
    expect(find.text('正在检查 FULI…'), findsOneWidget);
    await controller.refresh();
    await tester.pump();
    return (api, controller);
  }

  testWidgets('FULI works: the sentence, the folded version and the console button, nothing else', (tester) async {
    final (_, controller) = await showScenario(tester, 'ok');

    expect(find.text('FULI 正常工作'), findsOneWidget);
    expect(find.byTooltip('已安装 v0.22.0'), findsOneWidget);
    expect(find.text('已安装 v0.22.0'), findsNothing);
    expect(find.byType(ItemCard), findsNothing);
    expect(find.text('停止 FULI'), findsOneWidget);
    expect(find.text('自动修复'), findsNothing);

    await tester.tap(find.text('打开控制台'));
    expect(opener.opened.single, controller.consoleUri);
  });

  testWidgets('things that need the person: one card each, at most one button, no raw codes', (tester) async {
    await showScenario(tester, 'needs');

    expect(find.text('有 3 件事需要你'), findsOneWidget);
    expect(find.byType(ItemCard), findsNWidgets(4));
    expect(find.text('自动修复'), findsOneWidget);
    expect(find.text('Codex 接入 FULI 的设置已过期，需要重新接入。'), findsOneWidget);
    expect(find.text('有 2 个 Claude Code 会话还在用旧版 FULI（v0.21.0）。关掉并重新打开 Claude Code 即可。'), findsOneWidget);
    expect(find.text('查看并确认'), findsOneWidget);
    expect(find.text('更新到 v0.23.0'), findsOneWidget);
    for (final code in ['client_outdated', 'data_format_waiting', 'sessions_outdated', 'update_available']) {
      expect(find.textContaining(code), findsNothing);
    }
  });

  testWidgets('自动修复 repairs the automatic items and says so', (tester) async {
    await showScenario(tester, 'needs');

    await tester.tap(find.text('自动修复'));
    await tester.pump();
    await tester.pump();

    expect(find.text('已修复 1 件事。'), findsOneWidget);
    expect(find.text('自动修复'), findsNothing);
    expect(find.text('有 2 件事需要你'), findsOneWidget);
  });

  testWidgets('查看并确认 shows what changes and applies it with the shown digest', (tester) async {
    final (api, _) = await showScenario(tester, 'needs');

    await tester.tap(find.text('查看并确认'));
    await tester.pumpAndSettle();
    expect(find.text('确认数据格式变化'), findsOneWidget);
    expect(find.text('Tasks'), findsOneWidget);
    expect(find.text('版本 2 → 3 · 42 条记录'), findsOneWidget);
    expect(find.text('计划摘要 3f1c2a9b7d4e…'), findsOneWidget);

    await tester.tap(find.text('确认应用'));
    await tester.pumpAndSettle();
    expect(find.text('已应用。'), findsOneWidget);
    expect(api.requests, contains('applyMigration:${demoPlan.digest}'));

    await tester.tap(find.text('关闭'));
    await tester.pumpAndSettle();
    expect(find.text('查看并确认'), findsNothing);
  });

  testWidgets('FULI not running: 启动 FULI starts it through the runtime', (tester) async {
    await showScenario(tester, 'stopped');

    expect(find.text('FULI 没有运行'), findsOneWidget);
    await tester.tap(find.text('启动 FULI'));
    await tester.pump();
    await tester.pump();
    expect(find.text('FULI 正常工作'), findsOneWidget);
  });

  testWidgets('FULI not found: a link to the install page and no start button', (tester) async {
    await showScenario(tester, 'notfound');

    expect(find.text('没有找到 FULI'), findsOneWidget);
    expect(find.text('启动 FULI'), findsNothing);
    await tester.tap(find.text('打开安装页'));
    expect(opener.opened.single, installPage);
  });

  testWidgets('an older FULI without the doctor says so and still offers the update', (tester) async {
    await showScenario(tester, 'old');

    expect(find.text('FULI 正常工作'), findsOneWidget);
    expect(find.text('这个版本的 FULI 还不支持体检，更新后可用'), findsOneWidget);
    expect(find.text('更新到 v0.23.0'), findsOneWidget);
  });

  testWidgets('a blocking item: FULI cannot be used, and the card is explained', (tester) async {
    await showScenario(tester, 'degraded');

    expect(find.text('FULI 现在不能正常使用'), findsOneWidget);
    expect(find.text('Knowledge 的数据格式 FULI 不能自动处理，请在控制台的「数据格式迁移」里查看原因。'), findsOneWidget);
  });

  Widget console(Uri uri, VoidCallback onLoaded) {
    WidgetsBinding.instance.addPostFrameCallback((_) => onLoaded());
    return Text('console $uri');
  }

  testWidgets('with a WebView the window is the console once it answers', (tester) async {
    final (_, controller) = await showScenario(tester, 'needs', consoleView: console);

    // The console's own banner shows the findings; no status page beside it.
    await tester.pumpAndSettle();
    expect(find.text('console ${controller.consoleUri}'), findsOneWidget);
    expect(find.text('有 3 件事需要你'), findsNothing);
  });

  testWidgets('with a WebView, a stopped FULI shows the status page until it is started', (tester) async {
    final (_, controller) = await showScenario(tester, 'stopped', consoleView: console);

    expect(find.text('FULI 没有运行'), findsOneWidget);
    expect(find.text('打开控制台'), findsNothing);
    await tester.tap(find.text('启动 FULI'));
    await tester.pumpAndSettle();
    expect(find.text('console ${controller.consoleUri}'), findsOneWidget);
  });
}