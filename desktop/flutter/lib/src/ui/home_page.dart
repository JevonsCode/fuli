import 'package:flutter/material.dart';

import '../app/fuli_condition.dart';
import '../app/fuli_controller.dart';
import '../l10n/strings.dart';
import '../platform/ports.dart';
import 'item_card.dart';
import 'migration_dialog.dart';
import 'pending_line.dart';
import 'theme.dart';

final installPage = Uri.parse('https://xn--8ovp9s.xn--m8txu.com/fuli/');
const _maxWidth = 600.0;

/// The whole window: whether FULI works, what needs the person, and the
/// buttons that fix it.
class HomePage extends StatelessWidget {
  const HomePage({super.key, required this.controller, required this.strings, required this.opener});

  final FuliController controller;
  final Strings strings;
  final UrlOpener opener;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, _) {
          final snapshot = controller.snapshot;
          return Column(
            children: [
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(32, 40, 32, 24),
                  child: Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: _maxWidth),
                      child: snapshot == null ? PendingLine(label: strings.checking) : _content(context, snapshot),
                    ),
                  ),
                ),
              ),
              if (snapshot != null) _footer(snapshot),
            ],
          );
        },
      ),
    );
  }

  Widget _content(BuildContext context, FuliSnapshot snapshot) {
    final busy = controller.pending != null;
    final notice = controller.notice;
    final autoCount = snapshot.autoItems.length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _header(snapshot),
        if (snapshot.problem != null) ...[const SizedBox(height: 12), Text(snapshot.problem!, style: TypeScale.body)],
        if (snapshot.doctorUnsupported) ...[
          const SizedBox(height: 12),
          Text(strings.doctorUnsupported, style: TypeScale.secondary),
        ],
        if (snapshot.condition == FuliCondition.notFound) ...[
          const SizedBox(height: 12),
          Text(strings.notFoundBody, style: TypeScale.body),
          const SizedBox(height: 16),
          FilledButton(onPressed: () => opener.open(installPage), child: Text(strings.installPage)),
        ],
        if (controller.pending != null) ...[const SizedBox(height: 16), PendingLine(label: controller.pending!)],
        if (notice != null) ...[const SizedBox(height: 16), _notice(notice)],
        if (autoCount > 0) ...[
          const SizedBox(height: 24),
          _autoRepair(autoCount, busy),
        ],
        for (final item in snapshot.items) ...[
          const SizedBox(height: 12),
          ItemCard(
            item: item,
            strings: strings,
            enabled: !busy,
            onReview: () => showDialog<void>(
              context: context,
              builder: (_) => MigrationDialog(controller: controller, strings: strings),
            ),
            onUpdate: controller.update,
          ),
        ],
      ],
    );
  }

  Widget _header(FuliSnapshot snapshot) {
    final color = switch (snapshot.condition) {
      FuliCondition.ok => Palette.accent,
      FuliCondition.needsPerson => Palette.warning,
      _ => Palette.danger,
    };
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 11, right: 12),
          child: Container(width: 10, height: 10, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
        ),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Semantics(
                header: true,
                liveRegion: true,
                child: Text(snapshot.sentence(strings), key: const Key('status-sentence'), style: TypeScale.title),
              ),
              if (snapshot.version != null) Text(strings.installedVersion(snapshot.version!), style: TypeScale.secondary),
            ],
          ),
        ),
      ],
    );
  }

  Widget _notice(Notice notice) => Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: notice.error ? Palette.dangerSoft : Palette.accentSoft,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(notice.text, style: TypeScale.body.copyWith(color: notice.error ? Palette.danger : Palette.accent)),
      );

  Widget _autoRepair(int count, bool busy) => Row(
        children: [
          Expanded(child: Text(strings.autoRepairHint(count), style: TypeScale.section)),
          FilledButton(onPressed: busy ? null : controller.repair, child: Text(strings.autoRepair)),
        ],
      );

  Widget _footer(FuliSnapshot snapshot) {
    final busy = controller.pending != null;
    final toggle = snapshot.running
        ? OutlinedButton(onPressed: busy ? null : controller.stop, child: Text(strings.stopFuli))
        : FilledButton(onPressed: busy ? null : controller.start, child: Text(strings.startFuli));
    return Container(
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: Palette.border))),
      padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 16),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: _maxWidth),
          child: Row(
            children: [
              OutlinedButton(
                onPressed: snapshot.reached ? () => opener.open(controller.consoleUri) : null,
                child: Text(strings.openConsole),
              ),
              const Spacer(),
              if (snapshot.installed) toggle,
            ],
          ),
        ),
      ),
    );
  }
}
