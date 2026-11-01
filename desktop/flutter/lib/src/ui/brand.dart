import 'dart:convert';

import 'package:flutter/widgets.dart';

import 'svg_path.dart';

// The FULI brand in the client, in one place: the mark's geometry and its
// logo colours, read from assets/brand/fuli-mark.json (generated from the
// brand's mark SVGs, on a 512 x 512 view box), and the 复利 and FULI wordmarks
// from assets/brand/fuli-wordmark.json (generated from its wordmark SVGs). The
// logo colours belong to the mark and the wordmarks alone, never to the
// interface (the brand guidelines' scope rule).

const fuliMarkAsset = 'assets/brand/fuli-mark.json';
const fuliWordmarkAsset = 'assets/brand/fuli-wordmark.json';

/// The side of the view box the mark's paths are drawn on.
const fuliMarkViewBox = 512.0;

/// The gold orbit's gradient line in the view box, as the mark SVGs draw it.
const fuliGoldFrom = Offset(40, 298);
const fuliGoldTo = Offset(242, 474);

/// One optical size of the mark: the master from 28 px up, the micro (wider
/// channels) below.
class MarkGeometry {
  MarkGeometry.fromJson(Map<String, Object?> json)
      : orbitGold = parseSvgPath(json['orbitGold']! as String),
        orbitUpper = parseSvgPath(json['orbitUpper']! as String),
        wave = parseSvgPath(json['wave']! as String),
        bars = [for (final bar in json['bars']! as List) parseSvgPath(bar as String)];

  final Path orbitGold;
  final Path orbitUpper;
  final Path wave;
  // The three compounding bars, shortest first.
  final List<Path> bars;
}

/// One wordmark: its outline, drawn in the logo ink, on its view box (the
/// brand's clear space around the letters included).
class WordmarkGeometry {
  WordmarkGeometry.fromJson(Map<String, Object?> json)
      : viewBox = _rect(json['viewBox']! as List),
        outline = [for (final path in json['paths']! as List) parseSvgPath(path as String)]
            .fold(Path(), (outline, path) => outline..addPath(path, Offset.zero));

  final Rect viewBox;
  final Path outline;

  static Rect _rect(List<Object?> box) {
    final [x, y, width, height] = [for (final value in box) (value! as num).toDouble()];
    return Rect.fromLTWH(x, y, width, height);
  }
}

/// The mark and the wordmarks as the brand defines them, for a light surface
/// (the client has no dark mode).
class FuliBrand {
  FuliBrand.fromJson(Map<String, Object?> mark, Map<String, Object?> wordmarks)
      : master = MarkGeometry.fromJson(mark['master']! as Map<String, Object?>),
        micro = MarkGeometry.fromJson(mark['micro']! as Map<String, Object?>),
        gold = _stops((mark['gold']! as Map)['light']! as List),
        ink = _colour(mark['ink']! as String),
        chineseWordmark = WordmarkGeometry.fromJson(wordmarks['zh']! as Map<String, Object?>),
        latinWordmark = WordmarkGeometry.fromJson(wordmarks['en']! as Map<String, Object?>);

  final MarkGeometry master;
  final MarkGeometry micro;
  final List<(double, Color)> gold;
  final Color ink;
  // 复利 and FULI.
  final WordmarkGeometry chineseWordmark;
  final WordmarkGeometry latinWordmark;

  /// The geometry drawn at [size] logical pixels.
  MarkGeometry at(double size) => size < 28 ? micro : master;

  static Future<FuliBrand> load(AssetBundle bundle) async {
    Future<Map<String, Object?>> read(String asset) async =>
        jsonDecode(await bundle.loadString(asset)) as Map<String, Object?>;
    return FuliBrand.fromJson(await read(fuliMarkAsset), await read(fuliWordmarkAsset));
  }

  static Color _colour(String hex) => Color(0xFF000000 | int.parse(hex.replaceFirst('#', ''), radix: 16));

  // [[offset, '#hex'], …]; an offset is a fraction, a percentage, or '34%'.
  static List<(double, Color)> _stops(List<Object?> stops) => [
        for (final stop in stops.cast<List<Object?>>())
          (_fraction(stop[0]!), _colour(stop[1]! as String)),
      ];

  static double _fraction(Object offset) {
    if (offset is String) return double.parse(offset.replaceFirst('%', '')) / (offset.endsWith('%') ? 100 : 1);
    final value = (offset as num).toDouble();
    return value > 1 ? value / 100 : value;
  }
}

/// Hands the loaded brand to every mark below it, with the wordmark for the
/// client's language: 复利 when it speaks Chinese, FULI otherwise.
class FuliBrandScope extends InheritedWidget {
  const FuliBrandScope({super.key, required this.brand, required this.chinese, required super.child});

  final FuliBrand brand;
  final bool chinese;

  static FuliBrandScope _of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<FuliBrandScope>()!;

  static FuliBrand of(BuildContext context) => _of(context).brand;

  static WordmarkGeometry wordmarkOf(BuildContext context) {
    final scope = _of(context);
    return scope.chinese ? scope.brand.chineseWordmark : scope.brand.latinWordmark;
  }

  @override
  bool updateShouldNotify(FuliBrandScope old) => old.brand != brand || old.chinese != chinese;
}
