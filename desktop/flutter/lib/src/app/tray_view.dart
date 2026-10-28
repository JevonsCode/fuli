import '../l10n/strings.dart';
import '../platform/ports.dart';
import 'fuli_condition.dart';

/// The tray icon and its start/stop entry for the latest check.
TrayView trayViewOf(FuliSnapshot? snapshot, {required bool busy, required Strings strings}) {
  if (snapshot == null) {
    return TrayView(icon: TrayIcon.needsPerson, tooltip: 'FULI · ${strings.checking}',
        toggleLabel: strings.startFuli, toggleEnabled: false);
  }
  return TrayView(
    icon: switch (snapshot.condition) {
      FuliCondition.ok => TrayIcon.ok,
      FuliCondition.needsPerson => TrayIcon.needsPerson,
      _ => TrayIcon.broken,
    },
    tooltip: 'FULI · ${snapshot.sentence(strings)}',
    toggleLabel: snapshot.running ? strings.stopFuli : strings.startFuli,
    toggleEnabled: snapshot.installed && !busy,
  );
}
