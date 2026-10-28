import 'package:flutter/material.dart';

// The console's calm light palette and type scale
// (web/src/styles/theme/semantic.css and base.css). Light only.
abstract final class Palette {
  static const background = Color(0xFFF6F5F1);
  static const surface = Color(0xFFFFFEFB);
  static const surfaceSubtle = Color(0xFFF0EEE8);
  static const ink = Color(0xFF1B1F1D);
  static const muted = Color(0xFF626C66);
  static const border = Color(0xFFE5E2DA);
  static const controlBorder = Color(0xFFC9C5BA);
  static const accent = Color(0xFF0F6B55);
  static const accentSoft = Color(0xFFE5F0EB);
  static const warning = Color(0xFF8A5A12);
  static const warningSoft = Color(0xFFF8F0E0);
  static const danger = Color(0xFFA8392E);
  static const dangerSoft = Color(0xFFF8E9E6);
  static const shadow = Color(0x121B1F1D);
}

// 24 title, 16 section, 15 card title, 14 body, 13 secondary, 12 meta; 400/500/600 only.
abstract final class TypeScale {
  static const title = TextStyle(fontSize: 24, fontWeight: FontWeight.w600, height: 1.3, color: Palette.ink);
  static const section = TextStyle(fontSize: 16, fontWeight: FontWeight.w600, height: 1.4, color: Palette.ink);
  static const cardTitle = TextStyle(fontSize: 15, fontWeight: FontWeight.w500, height: 1.5, color: Palette.ink);
  static const body = TextStyle(fontSize: 14, fontWeight: FontWeight.w400, height: 1.6, color: Palette.ink);
  static const secondary = TextStyle(fontSize: 13, fontWeight: FontWeight.w400, height: 1.5, color: Palette.muted);
  static const meta = TextStyle(fontSize: 12, fontWeight: FontWeight.w400, height: 1.4, color: Palette.muted);
}

ThemeData fuliTheme() {
  const control = TextStyle(fontSize: 14, fontWeight: FontWeight.w500);
  final shape = RoundedRectangleBorder(borderRadius: BorderRadius.circular(8));
  const padding = EdgeInsets.symmetric(horizontal: 16, vertical: 10);
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    scaffoldBackgroundColor: Palette.background,
    colorScheme: ColorScheme.fromSeed(seedColor: Palette.accent, surface: Palette.surface)
        .copyWith(primary: Palette.accent, onSurface: Palette.ink),
    fontFamilyFallback: const ['PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Noto Sans CJK SC'],
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: Palette.accent,
        foregroundColor: Colors.white,
        textStyle: control,
        shape: shape,
        padding: padding,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: Palette.ink,
        side: const BorderSide(color: Palette.controlBorder),
        textStyle: control,
        shape: shape,
        padding: padding,
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: Palette.accent, textStyle: control, shape: shape),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: Palette.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
    ),
  );
}
