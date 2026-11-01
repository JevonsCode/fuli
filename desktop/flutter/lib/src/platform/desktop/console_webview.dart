import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import '../console_link.dart';
import '../ports.dart';
import 'download_saver.dart';

/// The console page inside the window (WebView2 on Windows, WKWebView on
/// macOS). Only the console's own origin loads here; any other link opens in
/// the default browser, as it would from the console in a browser tab. A file
/// the page exports is saved by the client (`fuliSaveFile`), since neither
/// WebView saves a page-made download for it.
class ConsoleWebView {
  ConsoleWebView._(this._environment, this._opener, this._saver, this._onSaved);

  final WebViewEnvironment? _environment;
  final UrlOpener _opener;
  final DownloadSaver _saver;
  final void Function(File file) _onSaved;

  static const saveHandler = 'fuliSaveFile';

  /// Null when this computer has no WebView runtime: the window then keeps
  /// its status page and opens the console in the browser.
  static Future<ConsoleWebView?> create(UrlOpener opener,
      {required DownloadSaver saver, required void Function(File file) onSaved}) async {
    if (!Platform.isWindows) return Platform.isMacOS ? ConsoleWebView._(null, opener, saver, onSaved) : null;
    try {
      if (await WebViewEnvironment.getAvailableVersion() == null) return null;
      // Outside the versioned program folder, so console settings kept in
      // the page (language, collapsed sections) survive updates.
      final local = Platform.environment['LOCALAPPDATA'];
      return ConsoleWebView._(
          await WebViewEnvironment.create(
              settings: WebViewEnvironmentSettings(
                  userDataFolder: local == null ? null : '$local\\FULI Desktop\\WebView2')),
          opener,
          saver,
          onSaved);
    } on Object {
      return null;
    }
  }

  /// [onLoaded] runs when the page has loaded, or could not, so the window
  /// stops waiting over it.
  Widget build(Uri console, VoidCallback onLoaded) => InAppWebView(
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
        // Only the console page itself may save; the answer tells it the file is on disk.
        onWebViewCreated: (controller) => controller.addJavaScriptHandler(
            handlerName: saveHandler,
            callback: (arguments) async {
              final page = await controller.getUrl();
              final request = arguments.firstOrNull;
              if (page == null || !isConsolePage(page, console) || request is! Map) {
                return {'saved': false, 'error': 'refused'};
              }
              final name = request['name'];
              final content = request['content'];
              if (name is! String || content is! String) return {'saved': false, 'error': 'invalid'};
              try {
                final file = await _saver.save(name, content);
                _onSaved(file);
                return {'saved': true, 'path': file.path};
              } on Object catch (error) {
                return {'saved': false, 'error': '$error'};
              }
            }),
        onLoadStop: (_, _) => onLoaded(),
        onReceivedError: (_, request, _) {
          if (request.isForMainFrame ?? true) onLoaded();
        },
        // target=_blank and window.open: never a second window inside FULI.
        onCreateWindow: (_, action) async {
          final url = action.request.url;
          if (url != null) await _opener.open(url);
          return false;
        },
      );
}
