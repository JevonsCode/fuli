import 'dart:collection';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import '../caption_controls.dart';
import '../console_link.dart';
import '../ports.dart';
import 'download_saver.dart';

/// The console page inside the window (WebView2 on Windows, WKWebView on
/// macOS). Only the console's own origin loads here; any other link opens in
/// the default browser, as it would from the console in a browser tab. A file
/// the page exports is saved by the client (`fuliSaveFile`), since neither
/// WebView saves a page-made download for it. The console draws its own
/// right-click menu, so the WebView's native one is off; its 粘贴 reads the
/// clipboard, which only the console's own page may. The console's top bar is
/// the window's title bar: the page learns where the window's own controls are
/// before it runs (`window.fuliDesktopClient`, web/src/lib/desktop-client.ts)
/// and asks the client to move or maximise the window (`fuliWindow`). Its
/// first-run guide reads and sets launch at login (`fuliLaunchAtLogin`), the
/// setting behind the tray menu's 「开机时启动」.
/// Launch at login as the tray menu holds it: [read] is the current choice
/// (null when reg.exe could not answer), [change] saves one and answers the
/// choice afterwards.
typedef LaunchAtLoginAccess = ({bool? Function() read, Future<bool?> Function(bool on) change});

class ConsoleWebView {
  ConsoleWebView._(this._environment, this._opener, this._saver, this._onSaved, this._caption, this._launchAtLogin);

  final WebViewEnvironment? _environment;
  final UrlOpener _opener;
  final DownloadSaver _saver;
  final void Function(File file) _onSaved;
  final CaptionControls _caption;
  final LaunchAtLoginAccess? _launchAtLogin;

  static const saveHandler = 'fuliSaveFile';
  static const windowHandler = 'fuliWindow';
  static const launchAtLoginHandler = 'fuliLaunchAtLogin';

  /// Null when this computer has no WebView runtime: the window then keeps
  /// its status page and opens the console in the browser.
  static Future<ConsoleWebView?> create(UrlOpener opener,
      {required DownloadSaver saver,
      required void Function(File file) onSaved,
      required CaptionControls caption,
      LaunchAtLoginAccess? launchAtLogin}) async {
    if (!Platform.isWindows) return Platform.isMacOS ? ConsoleWebView._(null, opener, saver, onSaved, caption, null) : null;
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
          onSaved,
          caption,
          launchAtLogin);
    } on Object {
      return null;
    }
  }

  // The page draws its own right-click menu and cancels the native one itself
  // (web/src/features/context-menu). Switching WebView2's menus off natively
  // made the whole window flash on every right-click (Jevons 11-01), so they
  // stay on and the page's preventDefault keeps them from showing.
  static InAppWebViewSettings settings() => InAppWebViewSettings(
        useShouldOverrideUrlLoading: true,
        supportMultipleWindows: true,
        disableContextMenu: false,
        isInspectable: kDebugMode,
      );

  /// Tells the page, before it runs, that it is the window's title bar and
  /// how much room the window's own controls take in its top corners.
  static UserScript desktopClientScript(CaptionControls caption) {
    final client = {
      'platform': caption.platform,
      'captionStart': caption.reserved.start,
      'captionEnd': caption.reserved.end,
    };
    return UserScript(
        source: 'window.fuliDesktopClient = Object.freeze(${jsonEncode(client)});',
        injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START);
  }

  /// Moves or maximises the window for the console page's top bar.
  static Future<void> windowAction(CaptionControls caption, Object? action) async => switch (action) {
        'drag' => caption.startDragging(),
        'toggleMaximize' => caption.toggleMaximize(),
        _ => null,
      };

  /// Answers the console page's `{}` (read) or `{enabled: bool}` (set) with
  /// `{available, enabled}`; unavailable without the setting (not an
  /// installed Windows FULI) or when reg.exe could not answer.
  static Future<Map<String, Object?>> launchAtLoginAction(LaunchAtLoginAccess? access, Object? request) async {
    const unavailable = {'available': false};
    if (access == null || request is! Map) return unavailable;
    final wanted = request['enabled'];
    if (request.containsKey('enabled') && wanted is! bool) return unavailable;
    final enabled = wanted is bool ? await access.change(wanted) : access.read();
    return enabled == null ? unavailable : {'available': true, 'enabled': enabled};
  }

  /// Grants the console page reading the clipboard (its own menu's 粘贴);
  /// every other request, and any request from another page, is denied.
  static PermissionResponseAction permissionFor(PermissionRequest request, Uri console) {
    final clipboardOnly = request.resources.isNotEmpty &&
        request.resources.every((resource) => resource == PermissionResourceType.CLIPBOARD_READ);
    return clipboardOnly && isConsolePage(request.origin, console)
        ? PermissionResponseAction.GRANT
        : PermissionResponseAction.DENY;
  }

  /// [onLoaded] runs when the page has loaded, or could not, so the window
  /// stops waiting over it.
  Widget build(Uri console, VoidCallback onLoaded) => InAppWebView(
        key: ValueKey(console),
        webViewEnvironment: _environment,
        initialUrlRequest: URLRequest(url: WebUri.uri(console)),
        initialSettings: settings(),
        initialUserScripts: UnmodifiableListView([desktopClientScript(_caption)]),
        onPermissionRequest: (_, request) async =>
            PermissionResponse(resources: request.resources, action: permissionFor(request, console)),
        shouldOverrideUrlLoading: (_, action) async {
          final url = action.request.url;
          if (url == null || isConsolePage(url, console)) return NavigationActionPolicy.ALLOW;
          await _opener.open(url);
          return NavigationActionPolicy.CANCEL;
        },
        // Only the console page itself may move the window, or save; the answer tells it the file is on disk.
        onWebViewCreated: (controller) {
          controller.addJavaScriptHandler(
              handlerName: windowHandler,
              callback: (arguments) async {
                final page = await controller.getUrl();
                if (page != null && isConsolePage(page, console)) await windowAction(_caption, arguments.firstOrNull);
              });
          controller.addJavaScriptHandler(
              handlerName: launchAtLoginHandler,
              callback: (arguments) async {
                final page = await controller.getUrl();
                if (page == null || !isConsolePage(page, console)) return {'available': false};
                return launchAtLoginAction(_launchAtLogin, arguments.firstOrNull);
              });
          controller.addJavaScriptHandler(
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
            },
          );
        },
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
