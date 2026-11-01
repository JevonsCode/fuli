# FULI vendored copy

This is `flutter_inappwebview_windows` **0.6.0** from pub.dev
(<https://pub.dev/packages/flutter_inappwebview_windows/versions/0.6.0>),
used through `dependency_overrides` in `desktop/flutter/pubspec.yaml`.
Only `CHANGELOG.md`, `LICENSE`, `README.md`, `analysis_options.yaml`,
`lib/`, `pubspec.yaml` and `windows/` were copied; `example/` and `test/`
were left out.

**The patches** (guarded by `desktop/flutter/test/vendored_webview_patches_test.dart`):

1. **No status bubble** (one line, in `windows/in_app_webview/in_app_webview.cpp`,
   where the WebView2 settings are first applied):

   ```cpp
   webView2Settings->put_IsStatusBarEnabled(FALSE);
   ```

   It hides WebView2's grey status bubble that shows a link's URL in the
   bottom-left corner on hover. 0.6.0 does not expose this setting.

2. **The WebView keeps the app window active.** In
   `windows/in_app_webview/in_app_webview_manager.cpp` the window each
   WebView2 is created in is a hidden *child* of the Flutter view
   (`WS_CHILD | WS_CLIPSIBLINGS`) instead of a hidden owned top-level window
   (style `0`). WebView2 moves keyboard focus to its own windows under it on a
   click; under a top-level window that activated it, so every click into the
   page deactivated the client window (its shadow and title went inactive)
   and the next click on the client flipped it back. `InAppWebView::setPosition`
   (`in_app_webview.cpp`) now places that window at the widget's offset in the
   view's client area instead of guessed screen coordinates, so it follows the
   client window when it moves, and calls `NotifyParentWindowPositionChanged`
   as WebView2 asks after its parent moves. Upstream (`master`, checked
   2026-11-01) still creates a top-level window.

**Drop this copy** only when a stable `flutter_inappwebview_windows` both
exposes `InAppWebViewSettings.statusBarEnabled` (it is in 0.7.0-beta.x /
`flutter_inappwebview` 6.2.0-beta.x) and creates the WebView's window as a
child: remove the override, upgrade `flutter_inappwebview`, and pass
`statusBarEnabled: false` in `lib/src/platform/desktop/console_webview.dart`.

---

# flutter\_inappwebview\_windows

The Windows WebView2 implementation of [`flutter_inappwebview`](https://pub.dev/packages/flutter_inappwebview).

## Usage

This package is [endorsed](https://flutter.dev/docs/development/packages-and-plugins/developing-packages#endorsed-federated-plugin),
which means you can simply use `flutter_inappwebview`
normally. This package will be automatically included in your app when you do,
so you do not need to add it to your `pubspec.yaml`.

However, if you `import` this package to use any of its APIs directly, you
should add it to your `pubspec.yaml` as usual.