import 'package:flutter/widgets.dart';

import 'brand.dart';
import 'fuli_mark.dart';

// The brand's compounding loading (motion/fuli-motion.css, "is-motion-loading"):
// the orbits sway into place and brighten, the wave fades in, and the three
// bars grow from their bases one after another, over one period.
const _period = Duration(milliseconds: 2200);
const _ease = Cubic(.42, 0, .2, 1);
const _barDelays = [0, 170, 340];

/// The loading mark: the FULI mark animated as the brand's loading. Still,
/// and at rest, under reduced motion. Inline (16 px) it draws the micro mark.
class FuliLoadingMark extends StatefulWidget {
  const FuliLoadingMark({super.key, this.size = 48});

  final double size;

  @override
  State<FuliLoadingMark> createState() => _FuliLoadingMarkState();
}

class _FuliLoadingMarkState extends State<FuliLoadingMark> with SingleTickerProviderStateMixin {
  late final _clock = AnimationController(vsync: this, duration: _period);

  bool get _still => MediaQuery.maybeDisableAnimationsOf(context) ?? false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_still) {
      _clock.stop();
    } else if (!_clock.isAnimating) {
      _clock.repeat();
    }
  }

  @override
  void dispose() {
    _clock.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final still = _still;
    return ExcludeSemantics(
      child: CustomPaint(
        size: Size.square(widget.size),
        painter: FuliMarkPainter(
          brand: FuliBrandScope.of(context),
          pose: still ? () => MarkPose.rest : () => _loadingPose(_clock.value),
          repaint: still ? null : _clock,
        ),
      ),
    );
  }
}

// The mark's pose at [phase] (0–1) of the loading period, by the brand's keyframes.
MarkPose _loadingPose(double phase) {
  double bar(int index, List<(double, double)> stops) =>
      _keyframes((phase - _barDelays[index] / _period.inMilliseconds) % 1, stops);
  return MarkPose(
    upperOpacity: _keyframes(phase, const [(0, .34), (.48, .92), (1, .34)]),
    upperTurn: _keyframes(phase, const [(0, -4), (.48, 0), (1, -4)]),
    goldOpacity: _keyframes(phase, const [(0, .52), (.42, 1), (1, .52)]),
    goldTurn: _keyframes(phase, const [(0, 4), (.42, 0), (1, 4)]),
    goldBrightness: _keyframes(phase, const [(0, .96), (.42, 1.24), (1, .96)]),
    waveOpacity: _keyframes(phase, const [(0, .45), (.45, 1), (1, .45)]),
    bars: [
      for (var index = 0; index < _barDelays.length; index++)
        (
          bar(index, const [(0, .28), (.12, .28), (.46, 1), (.58, 1), (1, .28)]),
          bar(index, const [(0, .38), (.12, .38), (.46, 1), (.58, 1), (1, .38)]),
        ),
    ],
  );
}

// A CSS keyframe track: [stops] run from 0 to 1, each step eased on its own.
double _keyframes(double phase, List<(double, double)> stops) {
  for (var index = 1; index < stops.length; index++) {
    final (end, to) = stops[index];
    if (phase <= end) {
      final (start, from) = stops[index - 1];
      final t = end == start ? 1.0 : (phase - start) / (end - start);
      return from + (to - from) * _ease.transform(t.clamp(0, 1));
    }
  }
  return stops.last.$2;
}
