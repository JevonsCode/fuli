import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/app/app_services.dart';
import 'package:fuli_desktop/src/app/fuli_controller.dart';
import 'package:fuli_desktop/src/l10n/strings.dart';
import 'package:fuli_desktop/src/platform/caption_controls.dart';
import 'package:fuli_desktop/src/preview/demo_fuli.dart';
import 'package:fuli_desktop/src/ui/brand.dart';
import 'package:fuli_desktop/src/ui/fuli_app.dart';
import 'package:fuli_desktop/src/ui/fuli_mark.dart';
import 'package:fuli_desktop/src/ui/theme.dart';
import 'package:fuli_desktop/src/ui/top_line.dart';
import 'package:fuli_desktop/src/ui/window_caption.dart';

import 'support/brand.dart';
import 'support/fakes.dart';

const en = Strings(chinese: false);

Widget branded(Widget home) => MaterialApp(
    builder: (context, child) => FuliBrandScope(brand: testBrand, chinese: false, child: child!), home: home);

Widget window(RecordingCaption caption, {Widget? content}) => branded(WindowChrome(
        caption: caption,
        strings: en,
        child: content ?? const Scaffold(body: Column(children: [TopLine(sentence: 'FULI is working')]))));

Color fillOf(WidgetTester tester, String glyph) =>
    (tester.widget<AnimatedContainer>(find.byKey(Key('caption-$glyph'))).decoration! as BoxDecoration).color!;

void main() {
  testWidgets('minimise, maximise and close do what the OS buttons do', (tester) async {
    final caption = RecordingCaption();
    await tester.pumpWidget(window(caption));

    await tester.tap(find.bySemanticsLabel('Minimize'));
    await tester.tap(find.bySemanticsLabel('Maximize'));
    await tester.tap(find.bySemanticsLabel('Close'));
    expect(caption.calls, ['minimize', 'toggleMaximize', 'close']);
  });

  testWidgets('the top line is the title bar: drag moves, double click maximises, right click opens the window menu',
      (tester) async {
    final caption = RecordingCaption();
    await tester.pumpWidget(window(caption));
    final bar = find.byType(TopLine);

    await tester.drag(bar, const Offset(120, 40));
    expect(caption.calls, ['startDragging']);

    caption.calls.clear();
    await tester.pump(kDoubleTapTimeout);
    await tester.tap(bar);
    await tester.pump(kDoubleTapMinTime);
    await tester.tap(bar);
    await tester.pumpAndSettle();
    expect(caption.calls, ['toggleMaximize']);

    caption.calls.clear();
    await tester.tap(bar, buttons: kSecondaryButton);
    await tester.pump(kDoubleTapTimeout);
    expect(caption.calls, ['showWindowMenu']);
  });

  testWidgets('one strip: the buttons sit in the top line, which keeps its sentence clear of them', (tester) async {
    await tester.pumpWidget(window(RecordingCaption()));
    final topLine = tester.getRect(find.byType(TopLine));
    final buttons = tester.getRect(find.byKey(const Key('caption-minimize'))).expandToInclude(
        tester.getRect(find.byKey(const Key('caption-close'))));

    expect(topLine.top, 0);
    expect(buttons.top, 0);
    expect(buttons.right, topLine.right);
    expect(buttons.size, const Size(138, 32));
    expect(tester.getRect(find.byKey(const Key('status-sentence'))).right, lessThanOrEqualTo(buttons.left - 8));
  });

  testWidgets('a maximised window offers restore, and the OS hover over the maximise button shows', (tester) async {
    final caption = RecordingCaption();
    await tester.pumpWidget(window(caption));

    caption.maximized.value = true;
    await tester.pump();
    expect(find.bySemanticsLabel('Restore'), findsOneWidget);
    expect(find.bySemanticsLabel('Maximize'), findsNothing);

    expect(fillOf(tester, 'restore').a, 0);
    caption.maximizeButtonState.value = NativeButtonState.hovered;
    await tester.pumpAndSettle();
    expect(fillOf(tester, 'restore'), FuliColors.surfaceHover);
    caption.maximizeButtonState.value = NativeButtonState.pressed;
    await tester.pumpAndSettle();
    expect(fillOf(tester, 'restore'), FuliColors.border);
  });

  testWidgets('close turns red under the pointer', (tester) async {
    await tester.pumpWidget(window(RecordingCaption()));
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(find.byKey(const Key('caption-close'))));
    await tester.pumpAndSettle();
    expect(fillOf(tester, 'close'), FuliColors.danger);
    expect(fillOf(tester, 'minimize').a, 0);
  });

  testWidgets('the OS learns where the maximise button is: the middle of three at the top right', (tester) async {
    final caption = RecordingCaption();
    await tester.pumpWidget(window(caption));
    await tester.pump();

    final (button, size) = caption.placed.last;
    expect(size.width - button.right, 46);
    expect(button.size, const Size(46, 32));
    expect(button.top, 0);
  });

  testWidgets('the buttons sit over the console page, which keeps the whole window', (tester) async {
    final caption = RecordingCaption();
    var consoleTaps = 0;
    await tester.pumpWidget(window(caption,
        content: GestureDetector(
            key: const Key('console'), onTap: () => consoleTaps++, child: const ColoredBox(color: FuliColors.bg))));

    expect(tester.getRect(find.byKey(const Key('console'))).topLeft, Offset.zero);
    await tester.tap(find.bySemanticsLabel('Minimize'));
    expect(caption.calls, ['minimize']);
    expect(consoleTaps, 0);
  });

  testWidgets('macOS keeps its traffic lights: no drawn buttons, room for them, the top line still moves the window',
      (tester) async {
    final caption = RecordingCaption(platform: 'macos');
    await tester.pumpWidget(window(caption));

    expect(find.byKey(const Key('caption-close')), findsNothing);
    expect(tester.getRect(find.byType(FuliMark)).left, greaterThanOrEqualTo(76 + 8));
    await tester.drag(find.byType(TopLine), const Offset(80, 0));
    await tester.pump(kDoubleTapTimeout);
    expect(caption.calls, ['startDragging']);
  });

  testWidgets('without a window caption (the web preview) the top line is plain', (tester) async {
    await tester.pumpWidget(branded(const Scaffold(body: Column(children: [TopLine(sentence: 'FULI')]))));
    expect(find.byType(GestureDetector), findsNothing);
    expect(tester.getRect(find.byType(FuliMark)).left, 32);
  });

  testWidgets('the buttons stay put as FULI is checked and the status page replaces the waiting screen',
      (tester) async {
    final caption = RecordingCaption();
    final (api, runtime) = demoScenario('stopped');
    final controller = FuliController(
        apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: en, wait: (_) async {});
    await tester.pumpWidget(FuliApp(
        brand: testBrand,
        services: AppServices(controller: controller, strings: en, opener: RecordingOpener(), caption: caption)));
    final closeWhileChecking = tester.getRect(find.byKey(const Key('caption-close')));
    expect(tester.getRect(find.byType(TopLine)).top, 0);

    await controller.refresh();
    await tester.pumpAndSettle();
    expect(find.text('FULI is not running'), findsOneWidget);
    expect(tester.getRect(find.byKey(const Key('caption-close'))), closeWhileChecking);
    expect(tester.getRect(find.byType(TopLine)).top, 0);
  });
}
