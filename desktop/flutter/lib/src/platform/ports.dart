// The side effects the app needs from the desktop, as small ports so the
// state logic runs in tests and in the web preview without plugins.

abstract interface class Notifier {
  /// Posts one OS notification; clicking it shows the window.
  Future<void> notify(String title, String body);
}

enum TrayIcon { ok, needsPerson, broken }

class TrayView {
  const TrayView({
    required this.icon,
    required this.tooltip,
    required this.toggleLabel,
    required this.toggleEnabled,
    this.changePortEnabled,
    this.launchAtLogin,
  });

  final TrayIcon icon;
  final String tooltip;
  final String toggleLabel;
  final bool toggleEnabled;
  // Null where the entry is not offered: the port change needs the Windows
  // tray controller, launch at login an installed Windows FULI.
  final bool? changePortEnabled;
  final bool? launchAtLogin;

  @override
  bool operator ==(Object other) =>
      other is TrayView &&
      other.icon == icon &&
      other.tooltip == tooltip &&
      other.toggleLabel == toggleLabel &&
      other.toggleEnabled == toggleEnabled &&
      other.changePortEnabled == changePortEnabled &&
      other.launchAtLogin == launchAtLogin;

  @override
  int get hashCode => Object.hash(icon, tooltip, toggleLabel, toggleEnabled, changePortEnabled, launchAtLogin);
}

abstract interface class TrayController {
  Future<void> show(TrayView view);
}

abstract interface class UrlOpener {
  Future<void> open(Uri uri);
}
