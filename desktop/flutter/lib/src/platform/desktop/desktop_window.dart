import 'dart:math';

import 'package:flutter/material.dart';
import 'package:screen_retriever/screen_retriever.dart';
import 'package:window_manager/window_manager.dart';

/// The one window, with its title bar hidden: the top bar of what it shows is
/// the title bar (window_caption.dart, desktop_caption.dart), while the frame keeps its
/// resize edges, shadow, rounded corners and snapping. Closing it hides it to
/// the tray; only 退出 quits. The Windows runner leaves it hidden until [open]
/// shows it (windows/runner/flutter_window.cpp), so a start at login stays in
/// the tray.
class DesktopWindow with WindowListener {
  ValueChanged<bool>? onVisibilityChanged;

  Future<void> open({required String title, bool show = true}) async {
    await windowManager.ensureInitialized();
    windowManager.addListener(this);
    final options = WindowOptions(
        size: await _openingSize(),
        minimumSize: const Size(460, 520),
        title: title,
        center: true,
        titleBarStyle: TitleBarStyle.hidden);
    await windowManager.waitUntilReadyToShow(options, () async {
      if (!show) return;
      await windowManager.show();
      await windowManager.focus();
    });
    await windowManager.setPreventClose(true);
  }

  // The window holds the console: wide enough for its pages, never larger
  // than 90% of a laptop screen's usable area.
  static Future<Size> _openingSize() async {
    try {
      final display = await screenRetriever.getPrimaryDisplay();
      return openingSize(display.visibleSize ?? display.size);
    } on Object {
      return const Size(1100, 760);
    }
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

/// 1280×860 where it fits, else 90% of the screen's usable [area].
Size openingSize(Size area) => Size(min(1280, area.width * 0.9), min(860, area.height * 0.9));
