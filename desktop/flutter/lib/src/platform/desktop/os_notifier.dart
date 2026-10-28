import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:local_notifier/local_notifier.dart';

import '../ports.dart';
import 'windows_registry.dart';

const _appId = 'FULI';

/// OS notifications (Windows toast, macOS Notification Center).
///
/// Windows shows toasts of an unpackaged app for an app identity registered
/// under the current user's AppUserModelId key. The plugin could instead
/// stamp the identity into a Start-menu shortcut named after the app, but
/// that is the installer's `Fuli.lnk`, and an update refuses a shortcut that
/// changed (src/desktop/windows-installation-switch.js), so it never touches it.
class OsNotifier implements Notifier {
  OsNotifier._(this._onClick);

  final VoidCallback _onClick;

  /// [windowsIcon]: the PNG Windows shows beside the toast.
  static Future<OsNotifier> create({required VoidCallback onClick, String? windowsIcon}) async {
    if (Platform.isWindows) await _registerWindowsIdentity(windowsIcon);
    await localNotifier.setup(appName: _appId, shortcutPolicy: ShortcutPolicy.ignore);
    return OsNotifier._(onClick);
  }

  @override
  Future<void> notify(String title, String body) async {
    final notification = LocalNotification(title: title, body: body)..onClick = _onClick;
    await notification.show();
  }

  // Uninstall removes this key (src/desktop/windows-desktop-client.js).
  static Future<void> _registerWindowsIdentity(String? icon) async {
    const key = r'HKCU\Software\Classes\AppUserModelId\' + _appId;
    await runReg(['add', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'FULI', '/f']);
    if (icon != null) await runReg(['add', key, '/v', 'IconUri', '/t', 'REG_SZ', '/d', icon, '/f']);
  }
}
