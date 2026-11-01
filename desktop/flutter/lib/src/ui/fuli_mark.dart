import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/widgets.dart';

import 'brand.dart';

// Where each layer turns or grows from, in the view box (motion/fuli-motion.css).
const _orbitCentre = Offset(256, 256);
const _barBases = [Offset(312, 324), Offset(366, 334), Offset(420, 316)];

/// How each layer of the mark stands at one moment. [MarkPose.rest] is the
/// mark as drawn. Turns are in degrees; a bar is (opacity, vertical scale).
class MarkPose {
  const MarkPose({
    this.upperOpacity = 1,
    this.upperTurn = 0,
    this.goldOpacity = 1,
    this.goldTurn = 0,
    this.goldBrightness = 1,
    this.waveOpacity = 1,
    this.bars = const [(1, 1), (1, 1), (1, 1)],
  });

  static const rest = MarkPose();

  final double upperOpacity;
  final double upperTurn;
  final double goldOpacity;
  final double goldTurn;
  final double goldBrightness;
  final double waveOpacity;
  final List<(double, double)> bars;
}

/// The FULI mark, still: the master geometry from 28 px up, the micro one below.
class FuliMark extends StatelessWidget {
  const FuliMark({super.key, this.size = 28});

  final double size;

  @override
  Widget build(BuildContext context) => Semantics(
        label: 'FULI',
        image: true,
        child: CustomPaint(
          size: Size.square(size),
          painter: FuliMarkPainter(brand: FuliBrandScope.of(context), pose: () => MarkPose.rest),
        ),
      );
}

/// Paints the mark in its logo colours: the gold orbit in the light black-gold
/// gradient, everything else in the logo ink. [pose] is read on every paint;
/// [repaint] says when it changed.
class FuliMarkPainter extends CustomPainter {
  FuliMarkPainter({required this.brand, required this.pose, super.repaint});

  final FuliBrand brand;
  final MarkPose Function() pose;

  @override
  void paint(Canvas canvas, Size size) {
    final geometry = brand.at(size.shortestSide);
    final now = pose();
    canvas.scale(size.width / fuliMarkViewBox, size.height / fuliMarkViewBox);
    Paint ink(double opacity) => Paint()..color = brand.ink.withValues(alpha: brand.ink.a * opacity);

    _turned(canvas, now.upperTurn, () => canvas.drawPath(geometry.orbitUpper, ink(now.upperOpacity)));
    _turned(canvas, now.goldTurn, () => canvas.drawPath(geometry.orbitGold, _gold(now)));
    canvas.drawPath(geometry.wave, ink(now.waveOpacity));
    for (var index = 0; index < geometry.bars.length; index++) {
      final (opacity, scale) = now.bars[index];
      final base = _barBases[index];
      canvas
        ..save()
        ..translate(base.dx, base.dy)
        ..scale(1, scale)
        ..translate(-base.dx, -base.dy)
        ..drawPath(geometry.bars[index], ink(opacity))
        ..restore();
    }
  }

  Paint _gold(MarkPose now) {
    final brightness = now.goldBrightness;
    return Paint()
      ..shader = ui.Gradient.linear(
          fuliGoldFrom, fuliGoldTo, [for (final (_, colour) in brand.gold) colour], [for (final (at, _) in brand.gold) at])
      // The paint's alpha fades the gradient.
      ..color = Color.fromRGBO(0, 0, 0, now.goldOpacity)
      ..colorFilter = brightness == 1
          ? null
          : ColorFilter.matrix([
              brightness, 0, 0, 0, 0, //
              0, brightness, 0, 0, 0, //
              0, 0, brightness, 0, 0, //
              0, 0, 0, 1, 0,
            ]);
  }

  static void _turned(Canvas canvas, double degrees, VoidCallback draw) {
    canvas
      ..save()
      ..translate(_orbitCentre.dx, _orbitCentre.dy)
      ..rotate(degrees * math.pi / 180)
      ..translate(-_orbitCentre.dx, -_orbitCentre.dy);
    draw();
    canvas.restore();
  }

  @override
  bool shouldRepaint(FuliMarkPainter old) => old.brand != brand || old.pose != pose;
}
