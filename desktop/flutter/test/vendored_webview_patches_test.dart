import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

// The Windows console runs in a patched, vendored copy of the WebView plugin
// (third_party/flutter_inappwebview_windows/README.md lists the patches). These
// guard against the override or a patch being dropped by accident, e.g. when
// the copy is refreshed from upstream.
void main() {
  const vendored = 'third_party/flutter_inappwebview_windows';
  String source(String path) => File('$vendored/windows/$path').readAsStringSync();

  test('pubspec overrides the Windows WebView plugin with the vendored copy', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    expect(
      pubspec,
      matches(RegExp(r'dependency_overrides:\s+flutter_inappwebview_windows:\s+path: ' + vendored)),
    );
  });

  test('vendored WebView2 settings turn the status bubble off', () {
    expect(source('in_app_webview/in_app_webview.cpp'), contains('webView2Settings->put_IsStatusBarEnabled(FALSE);'));
  });

  // Upstream creates it as a hidden owned top-level window (style 0); WebView2
  // focusing its windows under it deactivated the app window on every click.
  test('the WebView parent window is a child of the Flutter view', () {
    final manager = source('in_app_webview/in_app_webview_manager.cpp');
    expect(manager, contains('CreateWindowEx(0, windowClass_.lpszClassName, L"", WS_CHILD | WS_CLIPSIBLINGS, 0,'));
    // A child is placed in the view's client area, not at screen coordinates.
    final webview = source('in_app_webview/in_app_webview.cpp');
    expect(webview, isNot(contains('flutterWindowRect.left + scaled_x')));
    expect(webview, contains('webViewController->NotifyParentWindowPositionChanged();'));
  });

  // Upstream issue #2736: a press requested Flutter focus, which focused the
  // Flutter view after the press and blurred the page on every other click.
  test('a press hands focus straight to WebView2 and presses where the pointer is', () {
    final view = File('$vendored/lib/src/in_app_webview/custom_platform_view.dart').readAsStringSync();
    final onDown = view.substring(view.indexOf('onPointerDown:'), view.indexOf('onPointerUp:'));
    expect(onDown, isNot(contains('requestFocus')));
    expect(onDown.indexOf('_controller._moveFocus();'), greaterThanOrEqualTo(0));
    expect(onDown.indexOf('_controller._setCursorPos(ev.localPosition);'),
        lessThan(onDown.indexOf('_controller._setPointerButtonState(button, true);')));
    expect(view, contains('if (focused) _controller._moveFocus();'));
    expect(source('custom_platform_view/custom_platform_view.cc'), contains('view->moveFocus();'));
    expect(source('in_app_webview/in_app_webview.cpp'),
        contains('webViewController->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)'));
  });
}
