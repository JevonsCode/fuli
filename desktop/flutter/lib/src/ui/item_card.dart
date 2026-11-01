import 'package:flutter/material.dart';

import '../doctor/doctor_report.dart';
import '../l10n/strings.dart';
import 'status_card.dart';
import 'theme.dart';

const _knownKinds = {
  'client_outdated',
  'data_format_waiting',
  'data_format_blocked',
  'sessions_outdated',
  'update_available',
  'update_left_work',
  'ports_moved',
};

/// One doctor item as a card: its plain sentence and the one button that
/// acts on it, if any. 「自动修复」 runs the console's repair, which fixes
/// every automatic item at once.
class ItemCard extends StatelessWidget {
  const ItemCard({
    super.key,
    required this.item,
    required this.strings,
    required this.enabled,
    required this.onRepair,
    required this.onReview,
    required this.onUpdate,
  });

  final DoctorItem item;
  final Strings strings;
  final bool enabled;
  final VoidCallback onRepair;
  final VoidCallback onReview;
  final ValueChanged<String> onUpdate;

  @override
  Widget build(BuildContext context) {
    final (tone, icon) = switch (item.severity) {
      DoctorSeverity.blocking => (Tone.problem, Icons.error_outline_rounded),
      DoctorSeverity.warning => (Tone.attention, Icons.priority_high_rounded),
      DoctorSeverity.info => (Tone.quiet, Icons.info_outline_rounded),
    };
    return StatusCard(
      key: ValueKey('item-${item.id}'),
      tone: tone,
      icon: icon,
      sentence: strings.explain(item),
      detail: _detail(),
      action: _action(),
      lifted: item.severity == DoctorSeverity.blocking,
    );
  }

  // Folded detail only: the failed update's reason, or the kind this client
  // does not know yet (never the main sentence).
  String? _detail() {
    if (item.kind == 'update_left_work' && item.data['error'] is String) return item.data['error'] as String;
    return _knownKinds.contains(item.kind) ? null : item.kind;
  }

  Widget? _action() {
    final latest = item.data['latest'];
    if (item.fix == DoctorFix.auto) {
      return OutlinedButton(onPressed: enabled ? onRepair : null, child: Text(strings.autoRepair));
    }
    return switch (item.kind) {
      'data_format_waiting' => OutlinedButton(onPressed: enabled ? onReview : null, child: Text(strings.review)),
      'update_available' when latest is String && latest.isNotEmpty =>
        OutlinedButton(onPressed: enabled ? () => onUpdate(latest) : null, child: Text(strings.updateTo(latest))),
      _ => null,
    };
  }
}
