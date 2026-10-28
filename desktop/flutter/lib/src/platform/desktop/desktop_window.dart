import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

/// The one window. Closing it hides it to the tray; only 退出 quits. The
/// Windows runner leaves it hidden until [open] shows it
/// (windows/runner/flutter_window.cpp), so a start at login stays in the tray.
class DesktopWindow with WindowListener {
  ValueChanged<bool>? onVisibilityChanged;

  Future<void> open({bool show = true}) async {
    await windowManager.ensureInitialized();
    windowManager.addListener(this);
    const options = WindowOptions(size: Size(640, 760), minimumSize: Size(460, 520), title: 'FULI', center: true);
    await windowManager.waitUntilReadyToShow(options, () async {
      if (!show) return;
      await windowManager.show();
      await windowManager.focus();
    });
    await windowManager.setPreventClose(true);
  }

  Future<void> show() async {
    await windowManager.show();
    await windowManager.focus();
    onVisibilityChanged?.call(true);
  }

  Future<void> quit() async {
    windowManager.removeListener(this);
    await windowManager.setPreventClose(false);
    await windowManager.destroy();
  }

  @override
  Future<void> onWindowClose() async {
    await windowManager.hide();
    onVisibilityChanged?.call(false);
  }

  @override
  void onWindowMinimize() => onVisibilityChanged?.call(false);

  @override
  void onWindowRestore() => onVisibilityChanged?.call(true);
}
