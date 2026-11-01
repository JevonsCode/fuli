import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

// The Windows console must not show WebView2's grey hover-URL bubble. The
// stable plugin has no setting for it, so a patched copy is vendored; this
// guards against the override or the one-line patch being dropped by accident.
void main() {
  const vendored = 'third_party/flutter_inappwebview_windows';

  test('pubspec overrides the Windows WebView plugin with the vendored copy', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    expect(
      pubspec,
      matches(RegExp(r'dependency_overrides:\s+flutter_inappwebview_windows:\s+path: ' + vendored)),
    );
  });

  test('vendored WebView2 settings turn the status bubble off', () {
    final source = File('$vendored/windows/in_app_webview/in_app_webview.cpp').readAsStringSync();
    expect(source, contains('webView2Settings->put_IsStatusBarEnabled(FALSE);'));
  });
}
