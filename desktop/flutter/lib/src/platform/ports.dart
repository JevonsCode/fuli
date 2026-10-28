// The side effects the app needs from the desktop, as small ports so the
// state logic runs in tests and in the web preview without plugins.

abstract interface class Notifier {
  /// Posts one OS notification; clicking it shows the window.
  Future<void> notify(String title, String body);
}

enum TrayIcon { ok, needsPerson, broken }

class TrayView {
  const TrayView({required this.icon, required this.tooltip, required this.toggleLabel, required this.toggleEnabled});

  final TrayIcon icon;
  final String tooltip;
  final String toggleLabel;
  final bool toggleEnabled;

  @override
  bool operator ==(Object other) =>
      other is TrayView &&
      other.icon == icon &&
      other.tooltip == tooltip &&
      other.toggleLabel == toggleLabel &&
      other.toggleEnabled == toggleEnabled;

  @override
  int get hashCode => Object.hash(icon, tooltip, toggleLabel, toggleEnabled);
}

abstract interface class TrayController {
  Future<void> show(TrayView view);
}

abstract interface class UrlOpener {
  Future<void> open(Uri uri);
}
