import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:tray_manager/tray_manager.dart';

import '../../l10n/strings.dart';
import '../ports.dart';

/// The tray (Windows) or menu bar (macOS) icon in three states, with the menu
/// 打开 FULI · 打开控制台 · 启动/停止 · 退出.
class SystemTray with TrayListener implements TrayController {
  SystemTray({
    required this.strings,
    required this.onOpen,
    required this.onOpenConsole,
    required this.onToggle,
    required this.onQuit,
  }) {
    trayManager.addListener(this);
  }

  final Strings strings;
  final VoidCallback onOpen;
  final VoidCallback onOpenConsole;
  final VoidCallback onToggle;
  final VoidCallback onQuit;
  TrayView? _shown;

  @override
  Future<void> show(TrayView view) async {
    if (view == _shown) return;
    final iconChanged = view.icon != _shown?.icon;
    _shown = view;
    if (iconChanged) await trayManager.setIcon(_iconPath(view.icon));
    await trayManager.setToolTip(view.tooltip);
    await trayManager.setContextMenu(Menu(items: [
      MenuItem(key: 'open', label: strings.openFuli),
      MenuItem(key: 'console', label: strings.openConsole),
      MenuItem(key: 'toggle', label: view.toggleLabel, disabled: !view.toggleEnabled),
      MenuItem.separator(),
      MenuItem(key: 'quit', label: strings.quit),
    ]));
  }

  Future<void> remove() async {
    trayManager.removeListener(this);
    await trayManager.destroy();
  }

  // Windows needs .ico; macOS reads the PNG from the asset bundle.
  String _iconPath(TrayIcon icon) {
    final name = switch (icon) {
      TrayIcon.ok => 'ok',
      TrayIcon.needsPerson => 'needs_person',
      TrayIcon.broken => 'broken',
    };
    return 'assets/tray/$name.${Platform.isWindows ? 'ico' : 'png'}';
  }

  // Windows: left click opens the window, right click the menu. macOS: the
  // menu bar icon opens its menu.
  @override
  void onTrayIconMouseDown() => Platform.isWindows ? onOpen() : trayManager.popUpContextMenu();

  @override
  void onTrayIconRightMouseDown() => trayManager.popUpContextMenu();

  @override
  void onTrayMenuItemClick(MenuItem menuItem) {
    switch (menuItem.key) {
      case 'open':
        onOpen();
      case 'console':
        onOpenConsole();
      case 'toggle':
        onToggle();
      case 'quit':
        onQuit();
    }
  }
}
