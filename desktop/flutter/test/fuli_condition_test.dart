import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/app/fuli_condition.dart';
import 'package:fuli_desktop/src/app/notification_gate.dart';
import 'package:fuli_desktop/src/app/tray_view.dart';
import 'package:fuli_desktop/src/doctor/doctor_report.dart';
import 'package:fuli_desktop/src/l10n/strings.dart';
import 'package:fuli_desktop/src/platform/ports.dart';

const zh = Strings(chinese: true);
const en = Strings(chinese: false);

FuliSnapshot snapshot(FuliCondition condition, {List<DoctorItem> items = const [], bool running = true}) =>
    FuliSnapshot(condition: condition, port: 4100, installed: true, running: running, items: items);

const warning = DoctorItem(id: 'w', kind: 'codex_hooks_review', severity: DoctorSeverity.warning, fix: DoctorFix.person);
const info = DoctorItem(id: 'i', kind: 'update_available', severity: DoctorSeverity.info, fix: DoctorFix.person);

void main() {
  test('each condition has its status sentence; needs-person counts what is not information', () {
    expect(snapshot(FuliCondition.ok).sentence(zh), 'FULI 正常工作');
    expect(snapshot(FuliCondition.needsPerson, items: [warning, warning, info]).sentence(zh), '有 2 件事需要你');
    expect(snapshot(FuliCondition.needsPerson, items: [warning]).sentence(en), '1 thing needs you');
    expect(snapshot(FuliCondition.degraded).sentence(zh), 'FULI 现在不能正常使用');
    expect(snapshot(FuliCondition.notRunning).sentence(zh), 'FULI 没有运行');
    expect(snapshot(FuliCondition.notFound).sentence(zh), '没有找到 FULI');
  });

  test('the doctor overall maps onto the condition', () {
    expect(conditionOf(DoctorOverall.ok), FuliCondition.ok);
    expect(conditionOf(DoctorOverall.needsPerson), FuliCondition.needsPerson);
    expect(conditionOf(DoctorOverall.degraded), FuliCondition.degraded);
  });

  test('the tray shows three icon states and the matching start/stop entry', () {
    expect(trayViewOf(snapshot(FuliCondition.ok), busy: false, strings: zh).icon, TrayIcon.ok);
    expect(trayViewOf(snapshot(FuliCondition.needsPerson), busy: false, strings: zh).icon, TrayIcon.needsPerson);
    final stopped = trayViewOf(snapshot(FuliCondition.notRunning, running: false), busy: false, strings: zh);
    expect(stopped.icon, TrayIcon.broken);
    expect(stopped.toggleLabel, '启动 FULI');
    expect(stopped.tooltip, 'FULI Beta · FULI 没有运行');
    expect(trayViewOf(snapshot(FuliCondition.ok), busy: true, strings: zh).toggleEnabled, isFalse);
  });

  test('the port change and launch at login appear only where the platform offers them', () {
    final plain = trayViewOf(snapshot(FuliCondition.ok), busy: false, strings: zh);
    expect(plain.changePortEnabled, isNull);
    expect(plain.launchAtLogin, isNull);
    final windows = trayViewOf(snapshot(FuliCondition.ok), busy: false, strings: zh, canChangePort: true, launchAtLogin: false);
    expect(windows.changePortEnabled, isTrue);
    expect(windows.launchAtLogin, isFalse);
    expect(trayViewOf(snapshot(FuliCondition.ok), busy: true, strings: zh, canChangePort: true).changePortEnabled, isFalse);
    expect(trayViewOf(null, busy: false, strings: zh, canChangePort: true, launchAtLogin: true).launchAtLogin, isTrue);
  });

  group('NotificationGate', () {
    test('stays silent on the first check, even when FULI is already broken', () {
      expect(NotificationGate().observe(FuliCondition.notRunning), isFalse);
    });

    test('notifies once when FULI gets worse, never again for the same condition', () {
      final gate = NotificationGate();
      expect(gate.observe(FuliCondition.ok), isFalse);
      expect(gate.observe(FuliCondition.needsPerson), isTrue);
      expect(gate.observe(FuliCondition.needsPerson), isFalse);
      expect(gate.observe(FuliCondition.degraded), isTrue);
      expect(gate.observe(FuliCondition.needsPerson), isFalse);
      expect(gate.observe(FuliCondition.degraded), isFalse, reason: 'already notified for degraded');
      expect(gate.observe(FuliCondition.notRunning), isFalse, reason: 'not worse than degraded');
    });

    test('a recovery to ok lets the next worsening notify again', () {
      final gate = NotificationGate()..observe(FuliCondition.ok);
      expect(gate.observe(FuliCondition.notRunning), isTrue);
      expect(gate.observe(FuliCondition.ok), isFalse);
      expect(gate.observe(FuliCondition.notRunning), isTrue);
    });

    test('a change the person caused is recorded without a notification', () {
      final gate = NotificationGate()..observe(FuliCondition.ok);
      expect(gate.observe(FuliCondition.notRunning, quiet: true), isFalse);
      expect(gate.observe(FuliCondition.notRunning), isFalse);
    });
  });
}
