import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/app/app_services.dart';
import 'package:fuli_desktop/src/app/fuli_controller.dart';
import 'package:fuli_desktop/src/l10n/strings.dart';
import 'package:fuli_desktop/src/preview/demo_fuli.dart';
import 'package:fuli_desktop/src/ui/brand.dart';
import 'package:fuli_desktop/src/ui/fuli_mark.dart';
import 'package:fuli_desktop/src/ui/loading_mark.dart';
import 'package:fuli_desktop/src/ui/fuli_app.dart';
import 'package:fuli_desktop/src/ui/waiting_screen.dart';

import 'support/brand.dart';
import 'support/fakes.dart';

const zh = Strings(chinese: true);

void main() {
  late Completer<void> starting;
  VoidCallback? consoleLoaded;

  setUp(() => consoleLoaded = null);

  Widget console(Uri uri, VoidCallback onLoaded) {
    consoleLoaded = onLoaded;
    return Text('console $uri');
  }

  Future<FuliController> showStopped(WidgetTester tester, {bool webView = true}) async {
    // Made inside the test's zone, so completing it runs under the test's clock.
    starting = Completer<void>();
    final (api, runtime) = demoScenario('stopped', startTakes: () => starting.future);
    final controller = FuliController(apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    await tester.pumpWidget(FuliApp(
        brand: testBrand,
        services: AppServices(
            controller: controller, strings: zh, opener: RecordingOpener(), consoleView: webView ? console : null)));
    return controller;
  }

  Future<void> settleStart(WidgetTester tester, FuliController controller) async {
    starting.complete();
    for (var frame = 0; frame < 20 && controller.bringingUp != null; frame++) {
      await tester.pump();
    }
  }

  testWidgets('before the first check the window waits with the loading mark, never blank', (tester) async {
    final controller = await showStopped(tester);
    expect(find.byType(WaitingScreen), findsOneWidget);
    expect(find.byType(FuliLoadingMark), findsOneWidget);
    expect(find.text('正在检查 FULI…'), findsOneWidget);
    expect(find.byType(FuliMark), findsOneWidget);

    await controller.refresh();
    await tester.pump();
    expect(find.byType(WaitingScreen), findsNothing);
    expect(find.text('FULI 没有运行'), findsOneWidget);
  });

  testWidgets('from 启动 until the console page has loaded, the window waits and says what really happens',
      (tester) async {
    final controller = await showStopped(tester);
    await controller.refresh();
    await tester.pump();
    final mark = tester.getRect(find.byType(FuliMark));

    await tester.tap(find.text('启动 FULI'));
    await tester.pump();
    expect(find.text('正在启动 FULI…'), findsOneWidget);
    expect(find.byType(FuliLoadingMark), findsOneWidget);
    // The stopped page is gone, and the top line's mark stays where it was.
    expect(find.text('FULI 没有运行'), findsNothing);
    expect(find.text('启动 FULI'), findsNothing);
    expect(tester.getRect(find.byType(FuliMark)), mark);

    await settleStart(tester, controller);
    // The console answers: its page loads under the waiting screen.
    expect(find.text('console ${controller.consoleUri}'), findsOneWidget);
    expect(find.text('正在打开控制台…'), findsOneWidget);
    expect(find.text('FULI 没有运行'), findsNothing);

    consoleLoaded!();
    await tester.pumpAndSettle();
    expect(find.byType(WaitingScreen), findsNothing);
    expect(find.text('console ${controller.consoleUri}'), findsOneWidget);
  });

  testWidgets('without a WebView the start ends on the status page', (tester) async {
    final controller = await showStopped(tester, webView: false);
    await controller.refresh();
    await tester.pump();

    await tester.tap(find.text('启动 FULI'));
    await tester.pump();
    expect(find.text('正在启动 FULI…'), findsOneWidget);

    await settleStart(tester, controller);
    await tester.pump();
    expect(find.byType(WaitingScreen), findsNothing);
    expect(find.text('FULI 正常工作'), findsOneWidget);
    expect(find.text('停止 FULI'), findsOneWidget);
  });

  testWidgets('under reduced motion the waiting screen stands still', (tester) async {
    await tester.pumpWidget(FuliBrandScope(
      brand: testBrand,
      child: const MaterialApp(
        home: MediaQuery(data: MediaQueryData(disableAnimations: true), child: WaitingScreen(label: '正在启动 FULI…')),
      ),
    ));
    expect(find.text('正在启动 FULI…'), findsOneWidget);
    expect(tester.hasRunningAnimations, isFalse);
  });
}
