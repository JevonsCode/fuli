import 'package:flutter/material.dart';

import '../app/fuli_condition.dart';
import '../app/fuli_controller.dart';
import '../doctor/doctor_report.dart';
import '../l10n/strings.dart';
import '../platform/ports.dart';
import 'item_card.dart';
import 'migration_dialog.dart';
import 'pending_line.dart';
import 'theme.dart';

final installPage = Uri.parse('https://xn--8ovp9s.xn--m8txu.com/fuli/');
const _maxWidth = 600.0;

/// The whole window: whether FULI works, what needs the person, and the
/// buttons that fix it. One column; items are grouped by who acts on them.
class HomePage extends StatelessWidget {
  const HomePage(
      {super.key, required this.controller, required this.strings, required this.opener, this.consoleLink = true});

  final FuliController controller;
  final Strings strings;
  final UrlOpener opener;
  // Off where the window itself shows the console once it answers.
  final bool consoleLink;

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
                  padding: const EdgeInsets.fromLTRB(FuliSpace.space8, FuliSpace.space10, FuliSpace.space8, FuliSpace.space6),
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
    final auto = snapshot.autoItems;
    final person = snapshot.items
        .where((item) => item.fix != DoctorFix.auto && item.severity != DoctorSeverity.info)
        .toList();
    final notes = snapshot.items
        .where((item) => item.fix != DoctorFix.auto && item.severity == DoctorSeverity.info)
        .toList();
    Widget card(DoctorItem item) => ItemCard(
          item: item,
          strings: strings,
          enabled: !busy,
          onReview: () => showDialog<void>(
            context: context,
            builder: (_) => MigrationDialog(controller: controller, strings: strings),
          ),
          onUpdate: controller.update,
        );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _header(snapshot),
        if (snapshot.problem != null) ...[
          const SizedBox(height: FuliSpace.space4),
          Text(snapshot.problem!, style: TypeScale.body),
        ],
        if (snapshot.doctorUnsupported) ...[
          const SizedBox(height: FuliSpace.space3),
          Text(strings.doctorUnsupported, style: TypeScale.secondary),
        ],
        if (snapshot.condition == FuliCondition.notFound) ...[
          const SizedBox(height: FuliSpace.space3),
          Text(strings.notFoundBody, style: TypeScale.body),
          const SizedBox(height: FuliSpace.space5),
          FilledButton(onPressed: () => opener.open(installPage), child: Text(strings.installPage)),
        ],
        if (controller.pending != null) ...[
          const SizedBox(height: FuliSpace.space5),
          PendingLine(label: controller.pending!),
        ],
        if (notice != null) ...[const SizedBox(height: FuliSpace.space5), _notice(notice)],
        if (auto.isNotEmpty) ...[
          const SizedBox(height: FuliSpace.space8),
          _autoRepair(auto, busy),
        ],
        if (person.isNotEmpty) ...[
          if (auto.isEmpty) const SizedBox(height: FuliSpace.space2),
          _sectionLabel(strings.sectionNeedsYou),
          for (final item in person) ...[card(item), const SizedBox(height: FuliSpace.space3)],
        ],
        if (notes.isNotEmpty) ...[
          _sectionLabel(strings.sectionNotes),
          for (final item in notes) ...[card(item), const SizedBox(height: FuliSpace.space2)],
        ],
      ],
    );
  }

  Widget _header(FuliSnapshot snapshot) {
    final (tone, icon) = switch (snapshot.condition) {
      FuliCondition.ok => (Tone.ok, Icons.check_rounded),
      FuliCondition.needsPerson => (Tone.attention, Icons.priority_high_rounded),
      FuliCondition.notRunning => (Tone.quiet, Icons.power_settings_new_rounded),
      FuliCondition.notFound => (Tone.quiet, Icons.search_off_rounded),
      FuliCondition.degraded => (Tone.problem, Icons.close_rounded),
    };
    return Row(
      children: [
        Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(color: tone.soft, borderRadius: BorderRadius.circular(FuliSize.radiusCard)),
          child: Icon(icon, size: 24, color: tone.ink),
        ),
        const SizedBox(width: FuliSpace.space4),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Semantics(
                header: true,
                liveRegion: true,
                child: Text(snapshot.sentence(strings), key: const Key('status-sentence'), style: TypeScale.title),
              ),
              if (snapshot.version != null) ...[
                const SizedBox(height: 2),
                Text(strings.installedVersion(snapshot.version!), style: TypeScale.secondary),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _sectionLabel(String text) => Padding(
        padding: const EdgeInsets.only(top: FuliSpace.space6, bottom: FuliSpace.space3),
        child: Semantics(header: true, child: Text(text, style: TypeScale.meta.copyWith(fontWeight: FuliText.weightMedium))),
      );

  Widget _notice(Notice notice) {
    final tone = notice.error ? Tone.problem : Tone.ok;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: FuliSpace.space4, vertical: FuliSpace.space3),
      decoration: BoxDecoration(color: tone.soft, borderRadius: BorderRadius.circular(FuliSize.radiusControl)),
      child: Row(
        children: [
          Icon(notice.error ? Icons.error_outline_rounded : Icons.check_circle_outline_rounded, size: 18, color: tone.ink),
          const SizedBox(width: FuliSpace.space3),
          Expanded(child: Text(notice.text, style: TypeScale.body.copyWith(color: tone.ink))),
        ],
      ),
    );
  }

  // The things FULI fixes itself share one card and the window's one primary button.
  Widget _autoRepair(List<DoctorItem> items, bool busy) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(FuliSpace.space5),
        decoration: cardDecoration(),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(strings.autoRepairHint(items.length), style: TypeScale.section)),
                const SizedBox(width: FuliSpace.space4),
                FilledButton(onPressed: busy ? null : controller.repair, child: Text(strings.autoRepair)),
              ],
            ),
            const SizedBox(height: FuliSpace.space2),
            for (final item in items)
              Padding(
                key: ValueKey('item-${item.id}'),
                padding: const EdgeInsets.only(top: FuliSpace.space2),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Padding(
                      padding: EdgeInsets.only(top: 7, right: FuliSpace.space3),
                      child: SizedBox.square(
                        dimension: 6,
                        child: DecoratedBox(decoration: BoxDecoration(color: FuliColors.faint, shape: BoxShape.circle)),
                      ),
                    ),
                    Expanded(child: Text(strings.explain(item), style: TypeScale.body.copyWith(color: FuliColors.inkSoft))),
                  ],
                ),
              ),
          ],
        ),
      );

  Widget _footer(FuliSnapshot snapshot) {
    final busy = controller.pending != null;
    final toggle = snapshot.running
        ? OutlinedButton(onPressed: busy ? null : controller.stop, child: Text(strings.stopFuli))
        : FilledButton(onPressed: busy ? null : controller.start, child: Text(strings.startFuli));
    return Padding(
      padding: const EdgeInsets.fromLTRB(FuliSpace.space8, FuliSpace.space3, FuliSpace.space8, FuliSpace.space5),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: _maxWidth),
          child: Row(
            children: [
              if (consoleLink) TextButton.icon(
                onPressed: snapshot.reached ? () => opener.open(controller.consoleUri) : null,
                icon: const Icon(Icons.open_in_new_rounded, size: 16),
                label: Text(strings.openConsole),
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
