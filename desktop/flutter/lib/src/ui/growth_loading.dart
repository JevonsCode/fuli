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
  const GrowthLoading({super.key, required this.label, this.variant = GrowthLoadingVariant.inline});

  final String label;
  final GrowthLoadingVariant variant;

  @override
  Widget build(BuildContext context) {
    final page = variant == GrowthLoadingVariant.page;
    final text = Text(label, style: TypeScale.body.copyWith(color: FuliColors.muted), textAlign: page ? TextAlign.center : null);
    return Semantics(
      liveRegion: true,
      label: label,
      excludeSemantics: true,
      child: page
          ? Column(mainAxisSize: MainAxisSize.min, children: [
              const FuliLoadingMark(),
              const SizedBox(height: FuliSpace.space2),
              text,
            ])
          : Row(mainAxisSize: MainAxisSize.min, children: [
              const FuliLoadingMark(size: 16),
              const SizedBox(width: 6),
              Flexible(child: text),
            ]),
    );
  }
}
