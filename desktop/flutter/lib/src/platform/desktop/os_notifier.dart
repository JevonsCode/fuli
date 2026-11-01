import 'package:flutter/foundation.dart';
import 'package:local_notifier/local_notifier.dart';

import '../ports.dart';
import 'windows_notification_identity.dart';

/// OS notifications (Windows toast, macOS Notification Center).
///
/// On Windows the toasts use the identity the installed client registers
/// (windows_notification_identity.dart). The plugin could instead stamp the
/// identity into a Start-menu shortcut named after the app, but that is the
/// installer's `Fuli.lnk`, and an update refuses a shortcut that changed
/// (src/desktop/windows-installation-switch.js), so it never touches it.
class OsNotifier implements Notifier {
  OsNotifier._(this._onClick);

  final VoidCallback _onClick;

  static Future<OsNotifier> create({required VoidCallback onClick}) async {
    await localNotifier.setup(appName: notificationAppId, shortcutPolicy: ShortcutPolicy.ignore);
    return OsNotifier._(onClick);
  }

  @override
  Future<void> notify(String title, String body) async {
    final notification = LocalNotification(title: title, body: body)..onClick = _onClick;
    await notification.show();
  }
}
