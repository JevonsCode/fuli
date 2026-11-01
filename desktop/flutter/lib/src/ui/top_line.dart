import 'package:flutter/material.dart';

import '../app/fuli_condition.dart';
import 'fuli_mark.dart';
import 'glass_bar.dart';
import 'theme.dart';
import 'wordmark.dart';

const topLineHeight = 64.0;
const _dot = 8.0;

/// The window's top line: the FULI mark and the wordmark, then FULI's state in one sentence
/// after a status dot. [version] (the installed version, in words) waits in
/// the dot's tooltip.
/// Without a [sentence] (while waiting) it is the mark and the wordmark alone, at the same place.
class TopLine extends StatelessWidget {
  const TopLine({super.key, this.condition, this.sentence, this.version});

  final FuliCondition? condition;
  final String? sentence;
  final String? version;

  @override
  Widget build(BuildContext context) {
    final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    final motion = still ? Duration.zero : FuliMotion.medium;
    final sentence = this.sentence;
    final version = this.version;
    return GlassBar(
      height: topLineHeight,
      edge: AxisDirection.down,
      child: Row(
        children: [
          const FuliMark(),
          const SizedBox(width: FuliSpace.space2),
          const FuliWordmark(),
          if (sentence != null) ...[
            const SizedBox(width: FuliSpace.space6),
            _tooltip(
              version,
              AnimatedContainer(
                duration: motion,
                curve: FuliMotion.ease,
                width: _dot,
                height: _dot,
                decoration: BoxDecoration(color: _dotColour(condition), shape: BoxShape.circle),
              ),
            ),
            const SizedBox(width: FuliSpace.space3),
            Expanded(
              child: AnimatedSwitcher(
                duration: motion,
                layoutBuilder: (current, previous) =>
                    Stack(alignment: Alignment.centerLeft, children: [...previous, ?current]),
                child: Semantics(
                  key: ValueKey(sentence),
                  header: true,
                  liveRegion: true,
                  child: Text(sentence,
                      key: const Key('status-sentence'),
                      style: TypeScale.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  static Widget _tooltip(String? message, Widget child) =>
      message == null ? child : Tooltip(message: message, child: child);

  static Color _dotColour(FuliCondition? condition) => switch (condition) {
        FuliCondition.ok => FuliColors.success,
        FuliCondition.needsPerson => FuliColors.warning,
        FuliCondition.degraded => FuliColors.danger,
        _ => FuliColors.faint,
      };
}
