import 'strings.dart';

// The accessible names of the title strip's buttons, as Windows names its own.
// They are never drawn (the buttons are glyphs), so they stay outside
// strings.dart, whose every character the bundled Noto Sans SC subset must draw
// (test/client-fonts.test.js).
extension WindowControlNames on Strings {
  String get minimizeWindow => chinese ? '最小化' : 'Minimize';
  String get maximizeWindow => chinese ? '最大化' : 'Maximize';
  String get restoreWindow => chinese ? '还原' : 'Restore';
  String get closeWindow => chinese ? '关闭' : 'Close';
}
