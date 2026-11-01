import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/app/app_services.dart';
import 'package:fuli_desktop/src/app/fuli_controller.dart';
import 'package:fuli_desktop/src/l10n/strings.dart';
import 'package:fuli_desktop/src/platform/caption_controls.dart';
import 'package:fuli_desktop/src/preview/demo_fuli.dart';
import 'package:fuli_desktop/src/ui/fuli_app.dart';
import 'package:fuli_desktop/src/ui/theme.dart';
import 'package:fuli_desktop/src/ui/title_strip.dart';
import 'package:fuli_desktop/src/ui/top_line.dart';

import 'support/brand.dart';
import 'support/fakes.dart';

const en = Strings(chinese: false);

class RecordingCaption implements CaptionControls {
  RecordingCaption({this.drawsButtons = true});

  final calls = <String>[];
  final placed = <(Rect, Size)>[];

  @override
  final bool drawsButtons;

  @override
  double get height => 32;

  @override
  final ValueNotifier<bool> maximized = ValueNotifier(false);

  @override
  final ValueNotifier<NativeButtonState> maximizeButtonState = ValueNotifier(NativeButtonState.idle);

  @override
  Future<void> minimize() async => calls.add('minimize');

  @override
  Future<void> toggleMaximize() async => calls.add('toggleMaximize');

  @override
  Future<void> close() async => calls.add('close');

  @override
  Future<void> startDragging() async => calls.add('startDragging');

  @override
  Future<void> showWindowMenu() async => calls.add('showWindowMenu');

  @override
  void placeMaximizeButton(Rect button, Size window) => placed.add((button, window));
}

Widget strip(RecordingCaption caption) =>
    MaterialApp(home: Scaffold(body: Align(alignment: Alignment.topCenter, child: TitleStrip(caption: caption, strings: en))));

Color fillOf(WidgetTester tester, String glyph) =>
    (tester.widget<AnimatedContainer>(find.byKey(Key('caption-$glyph'))).decoration! as BoxDecoration).color!;

void main() {
  testWidgets('minimise, maximise and close do what the OS buttons do', (tester) async {
    final caption = RecordingCaption();
    await tester.pumpWidget(strip(caption));

    await tester.tap(find.bySemanticsLabel('Minimize'));
    await tester.tap(find.bySemanticsLabel('Maximize'));
    await tester.tap(find.bySemanticsLabel('Close'));
    expect(caption.calls, ['minimize', 'toggleMaximize', 'close']);
  });

  testWidgets('the strip moves the window, a double click maximises and a right click opens the window menu',
      (tester) async {
    final caption = RecordingCaption();
    await tester.pumpWidget(strip(caption));
    final drag = find.byKey(const Key('title-strip-drag'));

    await tester.drag(drag, const Offset(120, 40));
    expect(caption.calls, ['startDragging']);

    caption.calls.clear();
    await tester.tap(drag);
    await tester.pump(kDoubleTapMinTime);
    await tester.tap(drag);
    await tester.pumpAndSettle();
    expect(caption.calls, ['toggleMaximize']);

    caption.calls.clear();
    await tester.tap(drag, buttons: kSecondaryButton);
    expect(caption.calls, ['showWindowMenu']);
  });

  testWidgets('a maximised window offers restore, and the OS hover over the maximise button shows', (tester) async {
    final caption = RecordingCaption();
    await tester.pumpWidget(strip(caption));

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
    await tester.pumpWidget(strip(RecordingCaption()));
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(find.byKey(const Key('caption-close'))));
    await tester.pumpAndSettle();
    expect(fillOf(tester, 'close'), FuliColors.danger);
    expect(fillOf(tester, 'minimize').a, 0);
  });

  testWidgets('the OS learns where the maximise button is: the middle of three at the top right', (tester) async {
    final caption = RecordingCaption();
    await tester.pumpWidget(strip(caption));
    await tester.pump();

    final (button, window) = caption.placed.last;
    expect(window.width - button.right, 46);
    expect(button.size, const Size(46, 32));
    expect(button.top, 0);
  });

  testWidgets('macOS keeps its traffic lights: no drawn buttons, the strip still moves the window', (tester) async {
    final caption = RecordingCaption(drawsButtons: false);
    await tester.pumpWidget(strip(caption));

    expect(find.byType(AnimatedContainer), findsNothing);
    await tester.drag(find.byKey(const Key('title-strip-drag')), const Offset(80, 0));
    await tester.pump(kDoubleTapTimeout);
    expect(caption.calls, ['startDragging']);
  });

  testWidgets('the strip sits above the window content and its buttons stay put as FULI is checked', (tester) async {
    final caption = RecordingCaption();
    final (api, runtime) = demoScenario('stopped');
    final controller = FuliController(
        apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: en, wait: (_) async {});
    await tester.pumpWidget(FuliApp(
        brand: testBrand,
        services: AppServices(controller: controller, strings: en, opener: RecordingOpener(), caption: caption)));
    final closeWhileChecking = tester.getRect(find.byKey(const Key('caption-close')));
    expect(tester.getRect(find.byType(TopLine)).top, 32);

    await controller.refresh();
    await tester.pumpAndSettle();
    expect(find.text('FULI is not running'), findsOneWidget);
    expect(tester.getRect(find.byKey(const Key('caption-close'))), closeWhileChecking);
    expect(tester.getRect(find.byType(TopLine)).top, 32);
  });
}
