import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/platform/desktop/console_webview.dart';

import 'support/fakes.dart';

// The console draws its own right-click menu (Jevons 11-01), so the WebView's
// native one stays off, and only the console page may read the clipboard for
// that menu's 粘贴.
void main() {
  final console = Uri.parse('http://127.0.0.1:2828/');
  PermissionResponseAction answer(String origin, List<PermissionResourceType> resources) =>
      ConsoleWebView.permissionFor(PermissionRequest(origin: WebUri(origin), resources: resources), console);

  // Off natively it made the window flash on every right-click; the page cancels it instead.
  test('the native right-click menu is left to the page to cancel', () {
    expect(ConsoleWebView.settings().disableContextMenu, isFalse);
  });

  test('the console page may read the clipboard', () {
    expect(answer('http://127.0.0.1:2828/inbox', [PermissionResourceType.CLIPBOARD_READ]), PermissionResponseAction.GRANT);
  });

  test('another page, or any other permission, is denied', () {
    expect(answer('http://127.0.0.1:2829/', [PermissionResourceType.CLIPBOARD_READ]), PermissionResponseAction.DENY);
    expect(answer('https://example.com/', [PermissionResourceType.CLIPBOARD_READ]), PermissionResponseAction.DENY);
    expect(answer('http://127.0.0.1:2828/', [PermissionResourceType.CAMERA]), PermissionResponseAction.DENY);
    expect(answer('http://127.0.0.1:2828/', [PermissionResourceType.CLIPBOARD_READ, PermissionResourceType.MICROPHONE]),
        PermissionResponseAction.DENY);
    expect(answer('http://127.0.0.1:2828/', []), PermissionResponseAction.DENY);
  });

  test('the page learns, before it runs, where the window controls are', () {
    final windows = ConsoleWebView.desktopClientScript(RecordingCaption());
    expect(windows.injectionTime, UserScriptInjectionTime.AT_DOCUMENT_START);
    expect(windows.source,
        'window.fuliDesktopClient = Object.freeze({"platform":"windows","captionStart":0.0,"captionEnd":138.0});');
    expect(ConsoleWebView.desktopClientScript(RecordingCaption(platform: 'macos')).source,
        contains('"platform":"macos","captionStart":76.0,"captionEnd":0.0'));
  });

  test('the page moves or maximises the window, and nothing else', () async {
    final caption = RecordingCaption();
    for (final action in ['drag', 'toggleMaximize', 'close', null, 42]) {
      await ConsoleWebView.windowAction(caption, action);
    }
    expect(caption.calls, ['startDragging', 'toggleMaximize']);
  });

  // The first-run guide's 「开机启动」 switch: the tray menu's setting, read and set from the page.
  group('launch at login', () {
    bool? held = true;
    final changes = <bool>[];
    final access = (
      read: () => held,
      change: (bool on) async {
        changes.add(on);
        return held = on;
      },
    );
    setUp(() {
      held = true;
      changes.clear();
    });

    test('the page reads the choice and changes it', () async {
      expect(await ConsoleWebView.launchAtLoginAction(access, {}), {'available': true, 'enabled': true});
      expect(await ConsoleWebView.launchAtLoginAction(access, {'enabled': false}), {'available': true, 'enabled': false});
      expect(changes, [false]);
    });

    test('is unavailable without the setting, when reg.exe did not answer, or for a malformed request', () async {
      expect(await ConsoleWebView.launchAtLoginAction(null, {}), {'available': false});
      held = null;
      expect(await ConsoleWebView.launchAtLoginAction(access, {}), {'available': false});
      expect(await ConsoleWebView.launchAtLoginAction(access, 'on'), {'available': false});
      expect(await ConsoleWebView.launchAtLoginAction(access, {'enabled': 'yes'}), {'available': false});
      expect(changes, isEmpty);
    });
  });
}
