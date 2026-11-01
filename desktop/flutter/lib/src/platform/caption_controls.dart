import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';

/// What the OS itself shows of the maximise button the client draws. On
/// Windows the pointer over that button belongs to the OS, so its snap-layout
/// flyout opens there; the client only paints the state it reports.
enum NativeButtonState { idle, hovered, pressed }

/// The window's own title strip, in place of the OS's caption. Null where the
/// OS keeps all of it (the web preview).
abstract interface class CaptionControls {
  /// The strip's height: Windows' caption buttons, macOS's traffic lights.
  double get height;

  /// Minimise, maximise and close are drawn by the client (Windows); macOS
  /// keeps its traffic lights in the strip.
  bool get drawsButtons;

  ValueListenable<bool> get maximized;

  ValueListenable<NativeButtonState> get maximizeButtonState;

  Future<void> minimize();

  Future<void> toggleMaximize();

  /// Exactly what the OS's close does: the window hides to the tray.
  Future<void> close();

  /// Moves the window with the pointer that is down on the strip.
  Future<void> startDragging();

  /// The OS's window menu (restore, move, size, minimise, maximise, close).
  Future<void> showWindowMenu();

  /// Where the drawn maximise button is, in the window's logical pixels.
  void placeMaximizeButton(Rect button, Size window);
}
