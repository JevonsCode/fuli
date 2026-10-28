import '../l10n/strings.dart';
import '../platform/ports.dart';
import 'fuli_condition.dart';

/// The tray icon and its menu entries for the latest check. [canChangePort]
/// and [launchAtLogin] (null: not offered) come from the platform.
TrayView trayViewOf(FuliSnapshot? snapshot,
    {required bool busy, required Strings strings, bool canChangePort = false, bool? launchAtLogin}) {
  if (snapshot == null) {
    return TrayView(icon: TrayIcon.needsPerson, tooltip: 'FULI · ${strings.checking}',
        toggleLabel: strings.startFuli, toggleEnabled: false,
        changePortEnabled: canChangePort ? false : null, launchAtLogin: launchAtLogin);
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
    changePortEnabled: canChangePort ? snapshot.installed && !busy : null,
    launchAtLogin: launchAtLogin,
  );
}
