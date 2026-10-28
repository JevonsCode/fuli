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
  'codex_hooks_review',
};

/// One doctor item: a plain sentence and at most one button. Automatic items
/// have none here; they share the one 「自动修复」 above the list.
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
    final detail = _detail();
    final action = _action();
    return Container(
      key: ValueKey('item-${item.id}'),
      width: double.infinity,
      padding: EdgeInsets.all(info ? 14 : 18),
      decoration: BoxDecoration(
        color: info ? Palette.surfaceSubtle : Palette.surface,
        borderRadius: BorderRadius.circular(12),
        border: info ? null : Border.all(color: Palette.border),
        // A blocking item is lifted, not marked with a side bar.
        boxShadow: blocking ? const [BoxShadow(color: Palette.shadow, blurRadius: 20, offset: Offset(0, 6))] : null,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(strings.explain(item), style: info ? TypeScale.secondary.copyWith(color: Palette.ink) : TypeScale.cardTitle),
          if (detail != null) ...[
            const SizedBox(height: 6),
            Text(detail, style: TypeScale.meta),
          ],
          if (action != null) ...[
            SizedBox(height: info ? 10 : 14),
            action,
          ],
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
        FilledButton(onPressed: enabled ? () => onUpdate(latest) : null, child: Text(strings.updateTo(latest))),
      _ => null,
    };
  }
}
