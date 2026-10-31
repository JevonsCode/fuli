import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/l10n/strings.dart';
import 'package:fuli_desktop/src/platform/desktop/system_tray.dart';
import 'package:fuli_desktop/src/platform/fuli_link.dart';
import 'package:tray_manager/tray_manager.dart';

// The tray's 导出诊断包…: its menu entry and the console page it opens. The
// tray plugin's channel answers nothing here, so no real tray icon is made.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('导出诊断包… opens the settings page at the diagnostics card', () {
    final link = FuliLink.parse(diagnosticsLink)!;
    expect(link.opensClient, isFalse);
    expect(link.consolePage(3131).toString(), 'http://127.0.0.1:3131/settings?tab=system&setting=diagnostics');
  });

  test('the tray menu entry calls only its own action', () {
    final calls = <String>[];
    final tray = SystemTray(
      strings: const Strings(chinese: true),
      onOpen: () => calls.add('open'),
      onToggle: () => calls.add('toggle'),
      onExportDiagnostics: () => calls.add('diagnostics'),
      onQuit: () => calls.add('quit'),
    );
    tray.onTrayMenuItemClick(MenuItem(key: 'diagnostics', label: const Strings(chinese: true).exportDiagnostics));
    expect(calls, ['diagnostics']);
    expect(const Strings(chinese: true).exportDiagnostics, '导出诊断包…');
    expect(const Strings(chinese: false).exportDiagnostics, 'Export diagnostics bundle…');
  });
}
