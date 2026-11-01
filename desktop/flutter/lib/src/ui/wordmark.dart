import 'package:flutter/widgets.dart';

import 'brand.dart';

/// The wordmark for the client's language, 复利 or FULI, in the logo ink:
/// [height] logical pixels tall with the brand's clear space, as the console's
/// top bar shows it. The mark beside it already names FULI to screen readers.
class FuliWordmark extends StatelessWidget {
  const FuliWordmark({super.key, this.height = 15});

  final double height;

  @override
  Widget build(BuildContext context) {
    final wordmark = FuliBrandScope.wordmarkOf(context);
    final box = wordmark.viewBox;
    return ExcludeSemantics(
      child: CustomPaint(
        size: Size(height * box.width / box.height, height),
        painter: _WordmarkPainter(wordmark: wordmark, ink: FuliBrandScope.of(context).ink),
      ),
    );
  }
}

class _WordmarkPainter extends CustomPainter {
  _WordmarkPainter({required this.wordmark, required this.ink});

  final WordmarkGeometry wordmark;
  final Color ink;

  @override
  void paint(Canvas canvas, Size size) {
    final box = wordmark.viewBox;
    canvas
      ..scale(size.height / box.height)
      ..translate(-box.left, -box.top)
      ..drawPath(wordmark.outline, Paint()..color = ink);
  }

  @override
  bool shouldRepaint(_WordmarkPainter old) => old.wordmark != wordmark || old.ink != ink;
}
