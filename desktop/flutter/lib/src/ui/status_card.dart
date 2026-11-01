import 'package:flutter/material.dart';

import 'theme.dart';

/// One card of the status page: a tinted mark, one sentence and at most one
/// button on the right. A [detail] stays folded until the card is clicked;
/// the unfolded card lifts. A [lifted] card (something that blocks FULI) is
/// raised, never marked with a side bar; a [Tone.quiet] card sits on the
/// quiet surface.
class StatusCard extends StatefulWidget {
  const StatusCard({
    super.key,
    required this.tone,
    required this.icon,
    required this.sentence,
    this.detail,
    this.action,
    this.lifted = false,
  });

  final Tone tone;
  final IconData icon;
  final String sentence;
  final String? detail;
  final Widget? action;
  final bool lifted;

  @override
  State<StatusCard> createState() => _StatusCardState();
}

class _StatusCardState extends State<StatusCard> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final quiet = widget.tone == Tone.quiet;
    final detail = widget.detail;
    final action = widget.action;
    final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    final decoration = quiet && !_open
        ? BoxDecoration(
            color: FuliColors.surfaceSubtle,
            borderRadius: BorderRadius.circular(FuliSize.radiusCard),
            border: Border.all(color: FuliColors.surfaceSubtle))
        : cardDecoration(lifted: widget.lifted || _open);
    final sentence = Text(widget.sentence,
        style: quiet ? TypeScale.body.copyWith(color: FuliColors.inkSoft) : TypeScale.cardTitle);
    final card = AnimatedContainer(
      duration: still ? Duration.zero : FuliMotion.fast,
      curve: FuliMotion.ease,
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: FuliSpace.space5, vertical: FuliSpace.space4),
      decoration: decoration,
      child: Row(
        children: [
          Container(
            width: 28,
            height: 28,
            decoration: BoxDecoration(
              color: quiet ? FuliColors.surface : widget.tone.soft,
              borderRadius: BorderRadius.circular(FuliSize.radiusControl),
            ),
            child: Icon(widget.icon, size: 16, color: widget.tone.ink),
          ),
          const SizedBox(width: FuliSpace.space3),
          Expanded(
            child: detail == null
                ? sentence
                : Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(children: [
                        Flexible(child: sentence),
                        const SizedBox(width: FuliSpace.space1),
                        Icon(_open ? Icons.expand_less_rounded : Icons.expand_more_rounded,
                            size: 18, color: FuliColors.faint),
                      ]),
                      if (_open) ...[
                        const SizedBox(height: FuliSpace.space1),
                        Text(detail, style: TypeScale.meta),
                      ],
                    ],
                  ),
          ),
          if (action != null) ...[const SizedBox(width: FuliSpace.space4), action],
        ],
      ),
    );
    if (detail == null) return card;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: Semantics(
        button: true,
        expanded: _open,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => setState(() => _open = !_open),
          child: card,
        ),
      ),
    );
  }
}
