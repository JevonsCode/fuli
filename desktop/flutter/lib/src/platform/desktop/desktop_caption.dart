import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:window_manager/window_manager.dart';

import '../caption_controls.dart';

// Windows' caption metrics: buttons 46 x 32. macOS's title bar, where the
// traffic lights stay, is 28 high.
const _windowsHeight = 32.0;
const _macosHeight = 28.0;

/// The title strip's controls over window_manager. The window is opened with
/// its title bar hidden (desktop_window.dart). On Windows the runner gives the
/// drawn maximise button to the OS, so hovering it opens the snap layouts, and
/// keeps the top edge resizable (windows/runner/caption_frame.cpp); this
/// channel tells it where the button is and hears its hover and press.
class DesktopCaption with WindowListener implements CaptionControls {
  DesktopCaption._();

  static const _channel = MethodChannel('fuli/caption');

  final _maximized = ValueNotifier(false);
  final _maximizeButtonState = ValueNotifier(NativeButtonState.idle);
  Map<String, double>? _placed;

  static Future<DesktopCaption> create() async {
    final caption = DesktopCaption._();
    windowManager.addListener(caption);
    caption._maximized.value = await windowManager.isMaximized();
    if (Platform.isWindows) _channel.setMethodCallHandler(caption._fromRunner);
    return caption;
  }

  Future<void> _fromRunner(MethodCall call) async {
    if (call.method != 'maximizeButton') return;
    _maximizeButtonState.value =
        NativeButtonState.values.firstWhere((state) => state.name == call.arguments, orElse: () => NativeButtonState.idle);
  }

  @override
  double get height => Platform.isMacOS ? _macosHeight : _windowsHeight;

  @override
  bool get drawsButtons => Platform.isWindows;

  @override
  ValueListenable<bool> get maximized => _maximized;

  @override
  ValueListenable<NativeButtonState> get maximizeButtonState => _maximizeButtonState;

  @override
  Future<void> minimize() => windowManager.minimize();

  @override
  Future<void> toggleMaximize() async =>
      await windowManager.isMaximized() ? windowManager.unmaximize() : windowManager.maximize();

  // WM_CLOSE as the OS's own close button sends it; DesktopWindow hides the window.
  @override
  Future<void> close() => windowManager.close();

  @override
  Future<void> startDragging() => windowManager.startDragging();

  @override
  Future<void> showWindowMenu() async {
    if (Platform.isWindows) await windowManager.popUpWindowMenu();
  }

  // Anchored to the window's top right, as the button is, so the runner
  // keeps it in place while the window is resized.
  @override
  void placeMaximizeButton(Rect button, Size window) {
    if (!Platform.isWindows) return;
    final placed = {
      'right': window.width - button.right,
      'top': button.top,
      'width': button.width,
      'height': button.height,
    };
    if (mapEquals(placed, _placed)) return;
    _placed = placed;
    unawaited(_channel.invokeMethod<void>('placeMaximizeButton', placed));
  }

  @override
  void onWindowMaximize() => _maximized.value = true;

  @override
  void onWindowUnmaximize() => _maximized.value = false;
}
