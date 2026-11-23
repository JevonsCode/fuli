import 'package:flutter/widgets.dart';

import 'loading_mark.dart';
import 'theme.dart';

enum GrowthLoadingVariant { page, inline }

/// The one indicator for a running operation, as the console's GrowthLoading:
/// the brand's loading mark (the FULI mark animated) with the label of what is really being done,
/// announced as a live status. [GrowthLoadingVariant.page] stands the mark
/// over the label for a whole view; [GrowthLoadingVariant.inline] sits beside
/// an action.
class GrowthLoading extends StatelessWidget {
  const GrowthLoading({super.key, required this.label, this.detail, this.spokenDetail, this.variant = GrowthLoadingVariant.inline});

  final String label;

  /// One small line under the label for a wait that is taking long: how long it
  /// has waited and the longest it will wait. Only on the page variant.
  final String? detail;

  /// What a screen reader hears of [detail]: without the waited time, which
  /// changes every few seconds and would be announced again each time.
  final String? spokenDetail;
  final GrowthLoadingVariant variant;

  @override
  Widget build(BuildContext context) {
    final page = variant == GrowthLoadingVariant.page;
    final text = Text(label, style: TypeScale.body.copyWith(color: FuliColors.muted), textAlign: page ? TextAlign.center : null);
    final note = page && detail != null
        ? Text(detail!, style: TypeScale.meta, textAlign: TextAlign.center)
        : null;
    return Semantics(
      liveRegion: true,
      label: note == null || spokenDetail == null ? label : '$label $spokenDetail',
      excludeSemantics: true,
      child: page
          ? Column(mainAxisSize: MainAxisSize.min, children: [
              const FuliLoadingMark(),
              const SizedBox(height: FuliSpace.space2),
              text,
              if (note != null) ...[
                const SizedBox(height: FuliSpace.space1),
                ConstrainedBox(constraints: const BoxConstraints(maxWidth: 360), child: note),
              ],
            ])
          : Row(mainAxisSize: MainAxisSize.min, children: [
              const FuliLoadingMark(size: 16),
              const SizedBox(width: 6),
              Flexible(child: text),
            ]),
    );
  }
}
