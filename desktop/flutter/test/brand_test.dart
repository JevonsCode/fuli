import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/ui/brand.dart';
import 'package:fuli_desktop/src/ui/fuli_mark.dart';
import 'package:fuli_desktop/src/ui/loading_mark.dart';
import 'package:fuli_desktop/src/ui/svg_path.dart';

import 'support/brand.dart';

Widget _framed(Widget child, {bool still = false}) => FuliBrandScope(
      brand: testBrand,
      child: MaterialApp(
        home: MediaQuery(data: MediaQueryData(disableAnimations: still), child: Center(child: child)),
      ),
    );

// The painter that drew [finder]'s mark.
FuliMarkPainter _painter(WidgetTester tester, Finder finder) => tester
    .widget<CustomPaint>(find.descendant(of: finder, matching: find.byType(CustomPaint)))
    .painter! as FuliMarkPainter;

void main() {
  test('SVG path data becomes the same outline, absolute or relative', () {
    final absolute = parseSvgPath('M 10 10 L 30 10 Q 40 20 30 30 A 10 10 0 0 1 10 30 Z');
    final relative = parseSvgPath('m10 10 h20 q10 10 0 20 a10 10 0 0 1 -20 0 z');
    expect(relative.getBounds(), absolute.getBounds());
    expect(absolute.contains(const Offset(20, 20)), isTrue);
    expect(absolute.contains(const Offset(45, 20)), isFalse);
    expect(() => parseSvgPath('M0 0 S1 1 2 2'), throwsFormatException);
    expect(() => parseSvgPath('M0 0 Z 4 4'), throwsFormatException);
  });

  test('the brand reads both optical sizes and the light black-gold from fuli-mark.json', () {
    for (final geometry in [testBrand.master, testBrand.micro]) {
      expect(geometry.bars, hasLength(3));
      for (final layer in [geometry.orbitGold, geometry.orbitUpper, geometry.wave, ...geometry.bars]) {
        final bounds = layer.getBounds();
        expect(bounds.isEmpty, isFalse);
        expect(const Rect.fromLTWH(0, 0, fuliMarkViewBox, fuliMarkViewBox).inflate(1).contains(bounds.center), isTrue);
      }
    }
    // The micro mark's outer orbit is wider (R 236 against 224).
    expect(testBrand.micro.orbitGold.getBounds().width, greaterThan(testBrand.master.orbitGold.getBounds().width));
    expect(testBrand.ink, const Color(0xFF18181B));
    expect(testBrand.gold.first, (0.0, const Color(0xFFDC9A30)));
    expect(testBrand.gold.last, (1.0, const Color(0xFF18181B)));
    expect(testBrand.at(28), same(testBrand.master));
    expect(testBrand.at(16), same(testBrand.micro));
  });

  test('gradient offsets may come as fractions, percentages or "n%"', () {
    final json = jsonDecode(File('test/fixtures/fuli-mark.json').readAsStringSync()) as Map<String, Object?>;
    json['gold'] = {
      'light': [
        [0, '#DC9A30'],
        [34, '#B87B20'],
        ['100%', '#18181B'],
      ],
    };
    expect([for (final (at, _) in FuliBrand.fromJson(json).gold) at], [0, .34, 1]);
  });

  test('the shipped asset holds the same mark as the test fixture', () async {
    TestWidgetsFlutterBinding.ensureInitialized();
    final shipped = await FuliBrand.load(rootBundle);
    expect(shipped.gold, testBrand.gold);
    expect(shipped.master.wave.getBounds(), testBrand.master.wave.getBounds());
  });

  testWidgets('the mark is the master geometry from 28 px up and the micro one below', (tester) async {
    await tester.pumpWidget(_framed(const FuliMark()));
    expect(find.bySemanticsLabel('FULI'), findsOneWidget);
    expect(tester.getSize(find.byType(FuliMark)), const Size.square(28));
    expect(_painter(tester, find.byType(FuliMark)).pose(), same(MarkPose.rest));
  });

  testWidgets('the loading mark moves through the brand loading while shown and stops with it', (tester) async {
    await tester.pumpWidget(_framed(const FuliLoadingMark()));
    expect(tester.getSize(find.byType(FuliLoadingMark)), const Size.square(48));
    final painter = _painter(tester, find.byType(FuliLoadingMark));
    final start = painter.pose();
    // At the start of a period the bars are low and faint, the upper orbit turned back.
    expect(start.bars.first.$1, closeTo(.28, .001));
    expect(start.bars.first.$2, closeTo(.38, .001));
    expect(start.upperTurn, closeTo(-4, .001));

    await tester.pump(const Duration(milliseconds: 1150));
    final middle = painter.pose();
    expect(middle.bars.first.$1, closeTo(1, .001));
    expect(middle.bars.first.$2, closeTo(1, .001));
    expect(middle.upperOpacity, greaterThan(start.upperOpacity));
    expect(middle.goldBrightness, greaterThan(1));
    expect(tester.hasRunningAnimations, isTrue);

    await tester.pumpWidget(_framed(const SizedBox()));
    expect(tester.hasRunningAnimations, isFalse);
  });

  testWidgets('under reduced motion the loading mark is the still mark', (tester) async {
    await tester.pumpWidget(_framed(const FuliLoadingMark(size: 16), still: true));
    expect(tester.hasRunningAnimations, isFalse);
    expect(_painter(tester, find.byType(FuliLoadingMark)).pose(), same(MarkPose.rest));
  });
}
