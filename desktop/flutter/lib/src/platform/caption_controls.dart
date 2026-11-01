import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';

/// Windows' caption buttons, which the client draws over the window's top
/// right corner: minimise, maximise and close, each this size.
const captionButtonSize = Size(46, 32);

/// What the OS itself shows of the maximise button the client draws. On
/// Windows the pointer over that button belongs to the OS, so its snap-layout
/// flyout opens there; the client only paints the state it reports.
enum NativeButtonState { idle, hovered, pressed }

/// The window's own caption, in place of the OS's title bar: the top bar of
/// whatever the window shows is the title bar. Null where the OS keeps all of
/// it (the web preview).
abstract interface class CaptionControls {
  /// Windows or macOS, as the console page is told (`data-desktop-client`).
  String get platform;

  /// Minimise, maximise and close are drawn by the client (Windows); macOS
  /// keeps its traffic lights.
  bool get drawsButtons;

  /// Room the window's own controls take in the top corners: the traffic
  /// lights at the start (macOS), the drawn buttons at the end (Windows).
  ({double start, double end}) get reserved;

  ValueListenable<bool> get maximized;

  ValueListenable<NativeButtonState> get maximizeButtonState;

  Future<void> minimize();

  Future<void> toggleMaximize();

  /// Exactly what the OS's close does: the window hides to the tray.
  Future<void> close();

  /// Moves the window with the pointer that is down on the title bar.
  Future<void> startDragging();

  /// The OS's window menu (restore, move, size, minimise, maximise, close).
  Future<void> showWindowMenu();

  /// Where the drawn maximise button is, in the window's logical pixels.
  void placeMaximizeButton(Rect button, Size window);
}
