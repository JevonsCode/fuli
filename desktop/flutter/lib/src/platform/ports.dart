// The side effects the app needs from the desktop, as small ports so the
// state logic runs in tests and in the web preview without plugins.

import 'package:flutter/foundation.dart';

abstract interface class Notifier {
  /// Posts one OS notification; clicking it shows the window.
  Future<void> notify(String title, String body);
}

enum TrayIcon { ok, needsPerson, broken }

/// One line of what FULI is doing, in the tray menu under 打开 FULI. With a
/// [link] (a `fuli://` page) it opens that page; without one it is the
/// heading of the lines after it.
class TrayLine {
  const TrayLine(this.label, {this.link});
  final String label;
  final String? link;

  @override
  bool operator ==(Object other) => other is TrayLine && other.label == label && other.link == link;

  @override
  int get hashCode => Object.hash(label, link);
}

class TrayView {
  const TrayView({
    required this.icon,
    required this.tooltip,
    required this.toggleLabel,
    required this.toggleEnabled,
    this.lines = const [],
    this.changePortEnabled,
    this.launchAtLogin,
  });

  final TrayIcon icon;
  final String tooltip;
  final String toggleLabel;
  final bool toggleEnabled;
  final List<TrayLine> lines;
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
      listEquals(other.lines, lines) &&
      other.changePortEnabled == changePortEnabled &&
      other.launchAtLogin == launchAtLogin;

  @override
  int get hashCode =>
      Object.hash(icon, tooltip, toggleLabel, toggleEnabled, Object.hashAll(lines), changePortEnabled, launchAtLogin);
}

abstract interface class TrayController {
  Future<void> show(TrayView view);
}

abstract interface class UrlOpener {
  Future<void> open(Uri uri);
}
