import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/ui/theme.dart';

void main() {
  test('the theme writes Latin in the bundled Inter and Chinese in the bundled Noto Sans SC', () {
    final theme = fuliTheme();
    final styles = [
      theme.textTheme.bodyMedium!,
      theme.filledButtonTheme.style!.textStyle!.resolve({})!,
      theme.outlinedButtonTheme.style!.textStyle!.resolve({})!,
      theme.textButtonTheme.style!.textStyle!.resolve({})!,
      theme.tooltipTheme.textStyle!,
    ];
    for (final style in styles) {
      expect(style.fontFamily, 'Inter');
      expect(style.fontFamilyFallback, ['Noto Sans SC']);
    }
  });

  test('the client bundles both families at the design weights 400, 500 and 600', () async {
    TestWidgetsFlutterBinding.ensureInitialized();
    final manifest = jsonDecode(await rootBundle.loadString('FontManifest.json')) as List<Object?>;
    final weights = {
      for (final family in manifest.cast<Map<String, Object?>>())
        family['family']: [for (final font in (family['fonts']! as List).cast<Map<String, Object?>>()) font['weight']],
    };
    expect(weights['Inter'], [400, 500, 600]);
    expect(weights['Noto Sans SC'], [400, 500, 600]);
  });
}
