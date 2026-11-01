import 'package:flutter/material.dart';

import '../app/fuli_condition.dart';
import '../app/fuli_controller.dart';
import '../doctor/doctor_report.dart';
import '../l10n/strings.dart';
import '../platform/ports.dart';
import 'item_card.dart';
import 'migration_dialog.dart';
import 'status_actions.dart';
import 'status_card.dart';
import 'theme.dart';
import 'top_line.dart';

const _order = [DoctorSeverity.blocking, DoctorSeverity.warning, DoctorSeverity.info];

/// The status page, for when there is no console to show: the top line says
/// whether FULI works, one card per doctor item says what needs doing, and
/// the pinned bottom bar starts or stops FULI. Full width, one column; with
/// nothing to say, the page below the top line stays empty.
class HomePage extends StatelessWidget {
  const HomePage(
      {super.key,
      required this.controller,
      required this.snapshot,
      required this.strings,
      required this.opener,
      this.consoleLink = true});

  final FuliController controller;
  final FuliSnapshot snapshot;
  final Strings strings;
  final UrlOpener opener;
  // Off where the window itself shows the console once it answers.
  final bool consoleLink;

  @override
  Widget build(BuildContext context) {
    final version = snapshot.version;
    return Scaffold(
      backgroundColor: FuliColors.bg,
      body: Stack(
        children: [
          ListView(
            padding: const EdgeInsets.fromLTRB(FuliSpace.space8, topLineHeight + FuliSpace.space6, FuliSpace.space8,
                statusActionsHeight + FuliSpace.space6),
            children: [
              for (final card in _cards(context)) ...[card, const SizedBox(height: FuliSpace.space3)],
            ],
          ),
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: TopLine(
              condition: snapshot.condition,
              sentence: snapshot.sentence(strings),
              version: version == null ? null : strings.installedVersion(version),
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: StatusActions(
                controller: controller, snapshot: snapshot, strings: strings, opener: opener, consoleLink: consoleLink),
          ),
        ],
      ),
    );
  }

  // Why FULI cannot be used first, then what blocks it, what needs the person
  // or FULI's own repair, and the notes last.
  List<Widget> _cards(BuildContext context) {
    final busy = controller.pending != null;
    final problem = snapshot.problem;
    final items = [
      for (final severity in _order) ...snapshot.items.where((item) => item.severity == severity),
    ];
    return [
      if (problem != null) StatusCard(tone: Tone.problem, icon: Icons.error_outline_rounded, sentence: problem),
      if (snapshot.doctorUnsupported)
        StatusCard(tone: Tone.quiet, icon: Icons.info_outline_rounded, sentence: strings.doctorUnsupported),
      for (final item in items)
        ItemCard(
          item: item,
          strings: strings,
          enabled: !busy,
          onRepair: controller.repair,
          onReview: () => showDialog<void>(
            context: context,
            builder: (_) => MigrationDialog(controller: controller, strings: strings),
          ),
          onUpdate: controller.update,
        ),
    ];
  }
}
