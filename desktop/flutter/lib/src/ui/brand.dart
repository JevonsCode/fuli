import 'dart:convert';

import 'package:flutter/widgets.dart';

import 'svg_path.dart';

// The FULI brand in the client, in one place: the mark's geometry and its
// logo colours, read from assets/brand/fuli-mark.json (generated from the
// brand's mark SVGs, on a 512 x 512 view box). The logo colours belong to the
// mark alone, never to the interface (the brand guidelines' scope rule).

const fuliMarkAsset = 'assets/brand/fuli-mark.json';

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

/// The mark as the brand defines it, for a light surface (the client has no dark mode).
class FuliBrand {
  FuliBrand.fromJson(Map<String, Object?> json)
      : master = MarkGeometry.fromJson(json['master']! as Map<String, Object?>),
        micro = MarkGeometry.fromJson(json['micro']! as Map<String, Object?>),
        gold = _stops((json['gold']! as Map)['light']! as List),
        ink = _colour(json['ink']! as String);

  final MarkGeometry master;
  final MarkGeometry micro;
  final List<(double, Color)> gold;
  final Color ink;

  /// The geometry drawn at [size] logical pixels.
  MarkGeometry at(double size) => size < 28 ? micro : master;

  static Future<FuliBrand> load(AssetBundle bundle) async =>
      FuliBrand.fromJson(jsonDecode(await bundle.loadString(fuliMarkAsset)) as Map<String, Object?>);

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

/// Hands the loaded brand to every mark below it.
class FuliBrandScope extends InheritedWidget {
  const FuliBrandScope({super.key, required this.brand, required super.child});

  final FuliBrand brand;

  static FuliBrand of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<FuliBrandScope>()!.brand;

  @override
  bool updateShouldNotify(FuliBrandScope old) => old.brand != brand;
}
