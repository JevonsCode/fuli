import 'package:flutter/material.dart';

import '../app/fuli_condition.dart';
import '../app/fuli_controller.dart';
import '../l10n/strings.dart';
import '../platform/ports.dart';
import 'glass_bar.dart';
import 'growth_loading.dart';
import 'theme.dart';

final installPage = Uri.parse('https://xn--8ovp9s.xn--m8txu.com/fuli/');
const statusActionsHeight = 72.0;
// Wide enough for every label of the primary slot in both languages (the longest is
// "Open the install page"), so swapping 启动 and 停止 moves nothing.
const _primaryWidth = 176.0;

/// The status page's pinned bottom bar. 「打开控制台」 keeps the left end and
/// the one primary action (启动 / 停止 FULI, or the install page) the right
/// end; between them, the operation running now or the last one's outcome.
/// Nothing that appears or goes moves either button.
class StatusActions extends StatelessWidget {
  const StatusActions({
    super.key,
    required this.controller,
    required this.snapshot,
    required this.strings,
    required this.opener,
    required this.consoleLink,
  });

  final FuliController controller;
  final FuliSnapshot snapshot;
  final Strings strings;
  final UrlOpener opener;
  // Off where the window itself shows the console once it answers.
  final bool consoleLink;

  @override
  Widget build(BuildContext context) {
    return GlassBar(
      height: statusActionsHeight,
      edge: AxisDirection.up,
      child: Row(
        children: [
          if (consoleLink)
            TextButton.icon(
              key: const Key('open-console'),
              onPressed: snapshot.reached ? () => opener.open(controller.consoleUri) : null,
              icon: const Icon(Icons.open_in_new_rounded, size: 16),
              label: Text(strings.openConsole),
            ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: FuliSpace.space4),
              child: _statusLine(),
            ),
          ),
          SizedBox(key: const Key('primary-action'), width: _primaryWidth, child: _primary()),
        ],
      ),
    );
  }

  Widget _statusLine() {
    final pending = controller.pending;
    if (pending != null) return Align(alignment: Alignment.centerLeft, child: GrowthLoading(label: pending));
    final notice = controller.notice;
    if (notice == null) return const SizedBox.shrink();
    final tone = notice.error ? Tone.problem : Tone.quiet;
    return Tooltip(
      message: notice.text,
      child: Semantics(
        liveRegion: true,
        child: Text(notice.text,
            key: const Key('notice'),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TypeScale.secondary.copyWith(color: notice.error ? tone.ink : FuliColors.inkSoft)),
      ),
    );
  }

  Widget _primary() {
    final busy = controller.pending != null;
    if (!snapshot.installed) {
      return FilledButton(onPressed: () => opener.open(installPage), child: Text(strings.installPage));
    }
    return snapshot.running
        ? OutlinedButton(onPressed: busy ? null : controller.stop, child: Text(strings.stopFuli))
        : FilledButton(onPressed: busy ? null : controller.start, child: Text(strings.startFuli));
  }
}
