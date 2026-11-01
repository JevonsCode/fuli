import 'package:flutter/material.dart';

import 'fuli_tokens.g.dart';

export 'fuli_tokens.g.dart';

// The console's look in Flutter. Every value comes from fuli_tokens.g.dart,
// generated from web/src/styles/theme/; this file only maps the tokens onto
// Material widgets, the way components.css maps them onto shadcn-vue. Light only.

// The bundled OFL fonts (pubspec.yaml): Inter for Latin, Noto Sans SC for Chinese.
const _latinFont = 'Inter';
const _chineseFonts = ['Noto Sans SC'];

// 24 title, 16 section, 15 card title, 14 body, 13 control, 12 meta; 400/500/600 only.
abstract final class TypeScale {
  static const title = TextStyle(
      fontSize: FuliText.title, fontWeight: FuliText.weightStrong, height: FuliText.leadingTitle, color: FuliColors.ink);
  static const section = TextStyle(
      fontSize: FuliText.section, fontWeight: FuliText.weightStrong, height: FuliText.leadingHeading, color: FuliColors.ink);
  static const cardTitle = TextStyle(
      fontSize: FuliText.cardTitle, fontWeight: FuliText.weightMedium, height: FuliText.leadingHeading, color: FuliColors.ink);
  static const body = TextStyle(
      fontSize: FuliText.body, fontWeight: FuliText.weightRegular, height: FuliText.leadingProse, color: FuliColors.ink);
  static const secondary = TextStyle(
      fontSize: FuliText.control, fontWeight: FuliText.weightRegular, height: 1.5, color: FuliColors.muted);
  static const meta = TextStyle(
      fontSize: FuliText.meta, fontWeight: FuliText.weightRegular, height: 1.4, color: FuliColors.muted);
}

/// What a line or card is about: shown as a tinted mark, never a side bar.
enum Tone { ok, attention, problem, quiet }

extension ToneColors on Tone {
  Color get ink => switch (this) {
        Tone.ok => FuliColors.accent,
        Tone.attention => FuliColors.warning,
        Tone.problem => FuliColors.danger,
        Tone.quiet => FuliColors.muted,
      };
  Color get soft => switch (this) {
        Tone.ok => FuliColors.accentSoft,
        Tone.attention => FuliColors.warningSoft,
        Tone.problem => FuliColors.dangerSoft,
        Tone.quiet => FuliColors.surfaceSubtle,
      };
}

/// A card surface: hairline border and the console's resting shadow; a lifted
/// card (something that blocks FULI) takes the larger shadow instead of a colour bar.
BoxDecoration cardDecoration({bool lifted = false}) => BoxDecoration(
      color: FuliColors.surface,
      borderRadius: BorderRadius.circular(FuliSize.radiusCard),
      border: Border.all(color: FuliColors.border),
      boxShadow: lifted ? FuliShadow.md : FuliShadow.xs,
    );

ThemeData fuliTheme() {
  // Button and tooltip styles replace the ambient text style, so they name the fonts too.
  const control = TextStyle(
      fontFamily: _latinFont,
      fontFamilyFallback: _chineseFonts,
      fontSize: FuliText.control,
      fontWeight: FuliText.weightMedium,
      height: 1.2);
  final shape = RoundedRectangleBorder(borderRadius: BorderRadius.circular(FuliSize.radiusControl));
  const padding = EdgeInsets.symmetric(horizontal: FuliSpace.space4);
  const size = Size(0, FuliSize.controlHeight);
  const smallSize = Size(0, FuliSize.controlHeightSm);
  WidgetStateProperty<Color?> hover(Color colour) =>
      WidgetStateProperty.resolveWith((states) => states.contains(WidgetState.hovered) ? colour : null);
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    scaffoldBackgroundColor: FuliColors.bg,
    colorScheme: ColorScheme.fromSeed(seedColor: FuliColors.accent, surface: FuliColors.surface).copyWith(
      primary: FuliColors.accent,
      onPrimary: FuliColors.onAccent,
      onSurface: FuliColors.ink,
      outline: FuliColors.controlBorder,
      error: FuliColors.danger,
    ),
    fontFamily: _latinFont,
    fontFamilyFallback: _chineseFonts,
    splashFactory: NoSplash.splashFactory,
    visualDensity: VisualDensity.standard,
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: FuliColors.accent,
        foregroundColor: FuliColors.onAccent,
        disabledBackgroundColor: FuliColors.accent.withValues(alpha: .45),
        disabledForegroundColor: FuliColors.onAccent,
        textStyle: control,
        shape: shape,
        padding: padding,
        minimumSize: size,
        elevation: 0,
      ).copyWith(overlayColor: hover(FuliColors.accentHover.withValues(alpha: .35))),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: FuliColors.ink,
        backgroundColor: FuliColors.surface,
        disabledForegroundColor: FuliColors.faint,
        side: const BorderSide(color: FuliColors.controlBorder),
        textStyle: control,
        shape: shape,
        padding: padding,
        minimumSize: size,
      ).copyWith(overlayColor: hover(FuliColors.surfaceHover)),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: FuliColors.inkSoft,
        textStyle: control,
        shape: shape,
        padding: const EdgeInsets.symmetric(horizontal: FuliSpace.space3),
        minimumSize: smallSize,
      ).copyWith(overlayColor: hover(FuliColors.surfaceHover)),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: FuliColors.surface,
      surfaceTintColor: Colors.transparent,
      barrierColor: FuliColors.overlay,
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(FuliSize.radiusDialog)),
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: FuliColors.accent),
    tooltipTheme: TooltipThemeData(
      decoration: BoxDecoration(color: FuliColors.ink, borderRadius: BorderRadius.circular(FuliSize.radiusControl)),
      textStyle: const TextStyle(
          fontFamily: _latinFont, fontFamilyFallback: _chineseFonts, fontSize: FuliText.meta, color: FuliColors.surface),
    ),
  );
}
