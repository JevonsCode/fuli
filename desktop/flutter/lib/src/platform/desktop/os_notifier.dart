import 'package:flutter/foundation.dart';
import 'package:local_notifier/local_notifier.dart';

import '../ports.dart';

/// OS notifications (Windows toast, macOS Notification Center). Windows
/// toasts of an unpackaged app need a Start menu shortcut, which setup creates.
class OsNotifier implements Notifier {
  OsNotifier._(this._onClick);

  final VoidCallback _onClick;

  static Future<OsNotifier> create({required VoidCallback onClick}) async {
    await localNotifier.setup(appName: 'FULI', shortcutPolicy: ShortcutPolicy.requireCreate);
    return OsNotifier._(onClick);
  }

  @override
  Future<void> notify(String title, String body) async {
    final notification = LocalNotification(title: title, body: body)..onClick = _onClick;
    await notification.show();
  }
}
