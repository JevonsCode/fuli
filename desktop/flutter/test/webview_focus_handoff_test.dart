// The vendored plugin comes in through flutter_inappwebview and the override;
// its widget is not exported, so the test imports it directly.
// ignore_for_file: implementation_imports, depend_on_referenced_packages
import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_inappwebview_windows/src/in_app_webview/custom_platform_view.dart';
import 'package:flutter_test/flutter_test.dart';

// The vendored Windows WebView hands keyboard focus to WebView2 itself
// (third_party/flutter_inappwebview_windows/README.md, patch 3). These drive
// the widget against mocked plugin channels and check what reaches the native
// side, in order.
void main() {
  const textureId = 7;
  late List<MethodCall> calls;

  setUp(() {
    calls = [];
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(const MethodChannel('com.pichillilorenzo/flutter_inappwebview_manager'),
        (call) async => call.method == 'createInAppWebView' ? textureId : null);
    messenger.setMockMethodCallHandler(const MethodChannel('com.pichillilorenzo/custom_platform_view_$textureId'),
        (call) async {
      calls.add(call);
      return null;
    });
    messenger.setMockMethodCallHandler(
        const MethodChannel('com.pichillilorenzo/custom_platform_view_${textureId}_events'), (call) async => null);
  });

  Future<void> pumpView(WidgetTester tester, {FocusNode? other}) async {
    await tester.pumpWidget(Directionality(
      textDirection: TextDirection.ltr,
      child: Column(children: [
        Focus(focusNode: other, child: const SizedBox(height: 20, width: 20)),
        const Expanded(child: CustomPlatformView()),
      ]),
    ));
    await tester.pumpAndSettle();
  }

  List<String> methods() => [for (final call in calls) call.method];

  testWidgets('a press focuses the page first, then presses where the pointer is', (tester) async {
    await pumpView(tester);
    calls.clear();
    final gesture = await tester.createGesture(kind: PointerDeviceKind.mouse);
    // No hover before the press: the first move after the pointer is added is not one.
    await gesture.addPointer(location: const Offset(120, 140));
    await gesture.down(const Offset(120, 140));
    await tester.pump();
    final pressed = methods().where((m) => m == 'moveFocus' || m == 'setCursorPos' || m == 'setPointerButton').toList();
    expect(pressed, ['moveFocus', 'setCursorPos', 'setPointerButton']);
    final cursor = calls.firstWhere((call) => call.method == 'setCursorPos');
    expect(cursor.arguments, [120.0, 120.0]); // below the 20 px sibling
    await gesture.up();
  });

  testWidgets('a press does not take Flutter focus back to the Flutter view', (tester) async {
    final other = FocusNode();
    addTearDown(other.dispose);
    await pumpView(tester, other: other);
    other.requestFocus();
    await tester.pump();
    final gesture = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await gesture.addPointer(location: const Offset(120, 140));
    await gesture.down(const Offset(120, 140));
    await tester.pump();
    // Requesting Flutter focus here focused the Flutter view after the press
    // and blurred the page on every other click (upstream issue #2736).
    expect(other.hasPrimaryFocus, isTrue);
    await gesture.up();
  });

  testWidgets('Flutter focusing the view hands focus to the page', (tester) async {
    final other = FocusNode();
    addTearDown(other.dispose);
    await pumpView(tester, other: other);
    other.requestFocus();
    await tester.pump();
    calls.clear();
    // The window becoming active again focuses the Flutter view, which
    // restores focus to the platform view's node.
    other.nextFocus();
    await tester.pump();
    expect(methods(), contains('moveFocus'));
  });
}
