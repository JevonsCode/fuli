import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/l10n/strings.dart';
import 'package:fuli_desktop/src/platform/desktop/system_tray.dart';
import 'package:fuli_desktop/src/platform/fuli_link.dart';
import 'package:fuli_desktop/src/platform/ports.dart';
import 'package:tray_manager/tray_manager.dart';

// The tray menu's entries and what each one calls. The tray plugin's channel
// is answered here, so no real tray icon is made.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const zh = Strings(chinese: true);

  SystemTray trayCalling(List<String> calls) => SystemTray(
        strings: zh,
        onOpen: () => calls.add('open'),
        onOpenLink: (link) => calls.add('link $link'),
        onToggle: () => calls.add('toggle'),
        onExportDiagnostics: () => calls.add('diagnostics'),
        onQuit: () => calls.add('quit'),
      );

  test('导出诊断包… opens the settings page at the diagnostics card', () {
    final link = FuliLink.parse(diagnosticsLink)!;
    expect(link.opensClient, isFalse);
    expect(link.consolePage(3131).toString(), 'http://127.0.0.1:3131/settings?tab=system&setting=diagnostics');
  });

  test('the tray menu entry calls only its own action', () {
    final calls = <String>[];
    trayCalling(calls).onTrayMenuItemClick(MenuItem(key: 'diagnostics', label: zh.exportDiagnostics));
    expect(calls, ['diagnostics']);
    expect(zh.exportDiagnostics, '导出诊断包…');
    expect(const Strings(chinese: false).exportDiagnostics, 'Export diagnostics bundle…');
  });

  test('the lines of work sit under 打开 FULI; a line opens its page and a heading opens nothing', () async {
    final menus = <List<Map>>[];
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    const channel = MethodChannel('tray_manager');
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'setContextMenu') menus.add([...((call.arguments as Map)['menu'] as Map)['items'] as List].cast<Map>());
      return null;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    final calls = <String>[];
    final tray = trayCalling(calls);

    await tray.show(const TrayView(icon: TrayIcon.ok, tooltip: 'FULI', toggleLabel: '停止 FULI', toggleEnabled: true, lines: [
      TrayLine('1 个请求等你处理', link: 'fuli://workbench'),
      TrayLine('近 24 小时干过活的助手'),
      TrayLine('Synthetic Lead：R&D · 进行中', link: 'fuli://agents/s/lead'),
    ]));

    // A Windows menu takes a single & for a shortcut mark.
    final ampersand = Platform.isWindows ? '&&' : '&';
    expect([for (final item in menus.single) item['type'] == 'separator' ? '—' : '${item['label']}${item['disabled'] == true ? ' (off)' : ''}'], [
      '打开 FULI',
      '1 个请求等你处理',
      '—',
      '近 24 小时干过活的助手 (off)',
      'Synthetic Lead：R${ampersand}D · 进行中',
      '—',
      '停止 FULI',
      '导出诊断包…',
      '—',
      '退出',
    ]);
    final keys = [for (final item in menus.single) item['key']];
    tray.onTrayMenuItemClick(MenuItem(key: keys[4] as String, label: ''));
    tray.onTrayMenuItemClick(MenuItem(key: keys[3] as String, label: ''));
    expect(calls, ['link fuli://agents/s/lead']);

    // A check rebuilds the open menu with the rows in another order: the click
    // still opens the row it was on.
    await tray.show(const TrayView(icon: TrayIcon.ok, tooltip: 'FULI', toggleLabel: '停止 FULI', toggleEnabled: true, lines: [
      TrayLine('近 24 小时干过活的助手'),
      TrayLine('Synthetic Other：进行中', link: 'fuli://agents/s/other'),
      TrayLine('Synthetic Lead：R&D · 进行中', link: 'fuli://agents/s/lead'),
    ]));
    tray.onTrayMenuItemClick(MenuItem(key: keys[4] as String, label: ''));
    expect(calls.last, 'link fuli://agents/s/lead');

    await tray.show(const TrayView(icon: TrayIcon.ok, tooltip: 'FULI', toggleLabel: '停止 FULI', toggleEnabled: true));
    expect([for (final item in menus.last) item['type'] == 'separator' ? '—' : item['label']], ['打开 FULI', '停止 FULI', '导出诊断包…', '—', '退出'],
        reason: 'without lines the menu is the one it was');
  });
}
