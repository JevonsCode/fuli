import 'package:flutter/material.dart';

import '../doctor/doctor_report.dart';
import '../l10n/strings.dart';
import 'theme.dart';

const _knownKinds = {
  'client_outdated',
  'data_format_waiting',
  'data_format_blocked',
  'sessions_outdated',
  'update_available',
  'update_left_work',
  'ports_moved',
  'codex_hooks_review',
};

/// One doctor item the person acts on or reads: a tinted mark, a plain
/// sentence and at most one button on the right. Automatic items are not
/// cards; they share the 「自动修复」 card above.
class ItemCard extends StatelessWidget {
  const ItemCard({
    super.key,
    required this.item,
    required this.strings,
    required this.enabled,
    required this.onReview,
    required this.onUpdate,
  });

  final DoctorItem item;
  final Strings strings;
  final bool enabled;
  final VoidCallback onReview;
  final ValueChanged<String> onUpdate;

  @override
  Widget build(BuildContext context) {
    final info = item.severity == DoctorSeverity.info;
    final blocking = item.severity == DoctorSeverity.blocking;
    final (tone, icon) = switch (item.severity) {
      DoctorSeverity.blocking => (Tone.problem, Icons.error_outline_rounded),
      DoctorSeverity.warning => (Tone.attention, Icons.priority_high_rounded),
      DoctorSeverity.info => (Tone.quiet, Icons.info_outline_rounded),
    };
    final detail = _detail();
    final action = _action();
    return Container(
      key: ValueKey('item-${item.id}'),
      width: double.infinity,
      padding: EdgeInsets.all(info ? FuliSpace.space4 : FuliSpace.space5),
      // An information line sits on the quiet surface; something that blocks
      // FULI is lifted, never marked with a side bar.
      decoration: info
          ? BoxDecoration(color: FuliColors.surfaceSubtle, borderRadius: BorderRadius.circular(FuliSize.radiusCard))
          : cardDecoration(lifted: blocking),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Container(
            width: 28,
            height: 28,
            decoration: BoxDecoration(
              color: info ? FuliColors.surface : tone.soft,
              borderRadius: BorderRadius.circular(FuliSize.radiusControl),
            ),
            child: Icon(icon, size: 16, color: tone.ink),
          ),
          const SizedBox(width: FuliSpace.space3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(strings.explain(item), style: info ? TypeScale.body.copyWith(color: FuliColors.inkSoft) : TypeScale.cardTitle),
                if (detail != null) ...[
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
  }

  // Secondary text only: the failed update's reason, or the kind this client
  // does not know yet (never the main sentence).
  String? _detail() {
    if (item.kind == 'update_left_work' && item.data['error'] is String) return item.data['error'] as String;
    return _knownKinds.contains(item.kind) ? null : item.kind;
  }

  Widget? _action() {
    final latest = item.data['latest'];
    return switch (item.kind) {
      'data_format_waiting' => OutlinedButton(onPressed: enabled ? onReview : null, child: Text(strings.review)),
      'update_available' when latest is String && latest.isNotEmpty =>
        OutlinedButton(onPressed: enabled ? () => onUpdate(latest) : null, child: Text(strings.updateTo(latest))),
      _ => null,
    };
  }
}
