import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import '../console_link.dart';
import '../ports.dart';

/// The console page inside the window (WebView2 on Windows, WKWebView on
/// macOS). Only the console's own origin loads here; any other link opens in
/// the default browser, as it would from the console in a browser tab.
class ConsoleWebView {
  ConsoleWebView._(this._environment, this._opener);

  final WebViewEnvironment? _environment;
  final UrlOpener _opener;

  /// Null when this computer has no WebView runtime: the window then keeps
  /// its status page and opens the console in the browser.
  static Future<ConsoleWebView?> create(UrlOpener opener) async {
    if (!Platform.isWindows) return Platform.isMacOS ? ConsoleWebView._(null, opener) : null;
    try {
      if (await WebViewEnvironment.getAvailableVersion() == null) return null;
      // Outside the versioned program folder, so console settings kept in
      // the page (language, collapsed sections) survive updates.
      final local = Platform.environment['LOCALAPPDATA'];
      return ConsoleWebView._(
          await WebViewEnvironment.create(
              settings: WebViewEnvironmentSettings(
                  userDataFolder: local == null ? null : '$local\\FULI Desktop\\WebView2')),
          opener);
    } on Object {
      return null;
    }
  }

  Widget build(Uri console) => InAppWebView(
        key: ValueKey(console),
        webViewEnvironment: _environment,
        initialUrlRequest: URLRequest(url: WebUri.uri(console)),
        initialSettings: InAppWebViewSettings(
          useShouldOverrideUrlLoading: true,
          supportMultipleWindows: true,
          isInspectable: kDebugMode,
        ),
        shouldOverrideUrlLoading: (_, action) async {
          final url = action.request.url;
          if (url == null || isConsolePage(url, console)) return NavigationActionPolicy.ALLOW;
          await _opener.open(url);
          return NavigationActionPolicy.CANCEL;
        },
        // target=_blank and window.open: never a second window inside FULI.
        onCreateWindow: (_, action) async {
          final url = action.request.url;
          if (url != null) await _opener.open(url);
          return false;
        },
      );
}
