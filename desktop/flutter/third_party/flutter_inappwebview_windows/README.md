# FULI vendored copy

This is `flutter_inappwebview_windows` **0.6.0** from pub.dev
(<https://pub.dev/packages/flutter_inappwebview_windows/versions/0.6.0>),
used through `dependency_overrides` in `desktop/flutter/pubspec.yaml`.
Only `CHANGELOG.md`, `LICENSE`, `README.md`, `analysis_options.yaml`,
`lib/`, `pubspec.yaml` and `windows/` were copied; `example/` and `test/`
were left out.

**The patch** (one line, in `windows/in_app_webview/in_app_webview.cpp`,
where the WebView2 settings are first applied):

```cpp
webView2Settings->put_IsStatusBarEnabled(FALSE);
```

It hides WebView2's grey status bubble that shows a link's URL in the
bottom-left corner on hover. 0.6.0 does not expose this setting.

**Drop this copy** when a stable `flutter_inappwebview_windows` exposes
`InAppWebViewSettings.statusBarEnabled` (it is in 0.7.0-beta.x /
`flutter_inappwebview` 6.2.0-beta.x): remove the override, upgrade
`flutter_inappwebview`, and pass `statusBarEnabled: false` in
`lib/src/platform/desktop/console_webview.dart`.

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