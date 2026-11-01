import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/platform/desktop/console_webview.dart';

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
}
