import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:tray_manager/tray_manager.dart';

import '../../l10n/strings.dart';
import '../ports.dart';

/// The tray (Windows) or menu bar (macOS) icon in three states, with the menu
/// 打开 FULI · (what FULI is doing) · 启动/停止 · (Windows: 换一个端口) · 导出诊断包… ·
/// (Windows: 开机时启动) · 退出.
const _lineKey = 'line:';

class SystemTray with TrayListener implements TrayController {
  SystemTray({
    required this.strings,
    required this.onOpen,
    required this.onOpenLink,
    required this.onToggle,
    required this.onExportDiagnostics,
    required this.onQuit,
    this.onChangePort,
    this.onLaunchAtLogin,
  }) {
    trayManager.addListener(this);
  }

  final Strings strings;
  final VoidCallback onOpen;
  // A line of work was picked: its `fuli://` page.
  final ValueChanged<String> onOpenLink;
  final VoidCallback onToggle;
  final VoidCallback onExportDiagnostics;
  final VoidCallback onQuit;
  final VoidCallback? onChangePort;
  final ValueChanged<bool>? onLaunchAtLogin;
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
      for (final (index, line) in view.lines.indexed) ...[
        if (line.link == null) MenuItem.separator(),
        MenuItem(key: '$_lineKey$index', label: _menuText(line.label), disabled: line.link == null),
      ],
      if (view.lines.isNotEmpty) MenuItem.separator(),
      MenuItem(key: 'toggle', label: view.toggleLabel, disabled: !view.toggleEnabled),
      if (view.changePortEnabled != null)
        MenuItem(key: 'port', label: strings.changePort, disabled: !view.changePortEnabled!),
      MenuItem(key: 'diagnostics', label: strings.exportDiagnostics),
      if (view.launchAtLogin != null) ...[
        MenuItem.separator(),
        MenuItem.checkbox(key: 'login', label: strings.launchAtLogin, checked: view.launchAtLogin),
      ],
      MenuItem.separator(),
      MenuItem(key: 'quit', label: strings.quit),
    ]));
  }

  // A Windows menu reads & as the mark of a shortcut letter; && shows one &.
  String _menuText(String label) => Platform.isWindows ? label.replaceAll('&', '&&') : label;

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
    final key = menuItem.key ?? '';
    if (key.startsWith(_lineKey)) {
      final link = _shown?.lines.elementAtOrNull(int.parse(key.substring(_lineKey.length)))?.link;
      if (link != null) onOpenLink(link);
      return;
    }
    switch (key) {
      case 'open':
        onOpen();
      case 'toggle':
        onToggle();
      case 'port':
        onChangePort?.call();
      case 'diagnostics':
        onExportDiagnostics();
      case 'login':
        onLaunchAtLogin?.call(menuItem.checked != true);
      case 'quit':
        onQuit();
    }
  }
}
