import 'package:flutter/material.dart';

import '../app/fuli_condition.dart';
import '../app/fuli_controller.dart';
import '../l10n/strings.dart';
import '../platform/ports.dart';
import '../runtime/fuli_runtime.dart';
import 'glass_bar.dart';
import 'growth_loading.dart';
import 'theme.dart';

final installPage = Uri.parse('https://xn--8ovp9s.xn--m8txu.com/fuli/');
const statusActionsHeight = 72.0;
// Wide enough for every label of the primary slot in both languages (the longest is
// "Open the install page"), so swapping 启动 and 停止 moves nothing.
const _primaryWidth = 176.0;

/// The status page's pinned bottom bar. 「打开控制台」 (or, while the console
/// does not answer, 「重新检查」) keeps the left end and the one primary action
/// (启动 / 停止 / 重启 FULI, or the install page) the right end; between them,
/// the operation running now or the last one's outcome. Nothing that appears
/// or goes moves either button.
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
          // After a start that failed, the start's log is a click here.
          if (_startupLog case final folder?)
            TextButton.icon(
              key: const Key('notice-action'),
              onPressed: () => opener.open(Uri.directory(folder)),
              icon: const Icon(Icons.article_outlined, size: 16),
              label: Text(strings.viewStartupLog),
            )
          else if (snapshot.running && !snapshot.reached)
            TextButton.icon(
              key: const Key('recheck'),
              onPressed: controller.pending != null ? null : controller.recheck,
              icon: const Icon(Icons.refresh_rounded, size: 16),
              label: Text(strings.recheck),
            )
          else if (consoleLink)
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
          SizedBox(key: const Key('primary-action'), width: _primaryWidth, child: _primary(context)),
        ],
      ),
    );
  }

  String? get _startupLog => controller.pending == null ? controller.notice?.logDirectory : null;

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

  Widget _primary(BuildContext context) {
    final busy = controller.pending != null;
    if (!snapshot.installed) {
      return FilledButton(onPressed: () => opener.open(installPage), child: Text(strings.installPage));
    }
    // The last start stopped at an interrupted database operation: recovering
    // it is the one way on, after the person saw the plan and confirmed it.
    if (!snapshot.running && controller.recoverable) {
      return FilledButton(
        key: const Key('recover-start'),
        onPressed: busy ? null : () => _confirmRecovery(context),
        child: Text(strings.recoverAndStart),
      );
    }
    // The last start stopped at a maintenance lock a person may release: the
    // one way on, confirmed first; FULI's own checks decide (neo4j-lifecycle-lock.js).
    if (!snapshot.running && controller.releasableLock) {
      return FilledButton(
        key: const Key('release-lock-start'),
        onPressed: busy ? null : () => _confirmReleaseLock(context),
        child: Text(strings.releaseLockAndStart),
      );
    }
    // Running without an answering console: restarting is what fixes it.
    if (snapshot.running && !snapshot.reached) {
      return FilledButton(onPressed: busy ? null : controller.restart, child: Text(strings.restartFuli));
    }
    return snapshot.running
        ? OutlinedButton(onPressed: busy ? null : controller.stop, child: Text(strings.stopFuli))
        : FilledButton(onPressed: busy ? null : controller.start, child: Text(strings.startFuli));
  }

  Future<void> _confirmReleaseLock(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(strings.releaseLockTitle),
        content: Text(strings.releaseLockBody),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: Text(strings.cancel)),
          FilledButton(
            key: const Key('release-lock-confirm'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(strings.releaseLockConfirm),
          ),
        ],
      ),
    );
    if (confirmed == true) await controller.releaseLockAndStart();
  }

  // The plan in the window's words; a switch that can also be backed out
  // offers both, each with its own button, and says how they differ.
  Future<void> _confirmRecovery(BuildContext context) async {
    final plan = await controller.previewRecovery();
    if (plan == null || !context.mounted) return;
    final alternative = plan.alternative;
    final other = strings.recoveryAlternativeWords(plan);
    final words = [...strings.recoveryPlanWords(plan), if (other != null) ...['', other]];
    final switching = plan.kind == 'finish_switch' || plan.kind == 'back_out_switch';
    final chosen = await showDialog<RecoveryPlan>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(strings.recoveryTitle),
        content: SingleChildScrollView(child: Text(words.join('\n'))),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: Text(strings.cancel)),
          if (alternative != null)
            OutlinedButton(
              key: const Key('recover-alternative'),
              onPressed: () => Navigator.of(dialogContext).pop(alternative),
              child: Text(alternative.kind == 'back_out_switch' ? strings.backOutTo(plan.text('fromVersion')) : strings.keepVersion(plan.text('toVersion'))),
            ),
          FilledButton(
            key: const Key('recover-confirm'),
            onPressed: () => Navigator.of(dialogContext).pop(plan),
            child: Text(switching && alternative != null
                ? (plan.kind == 'finish_switch' ? strings.keepVersion(plan.text('toVersion')) : strings.backOutTo(plan.text('fromVersion')))
                : strings.recoveryConfirm),
          ),
        ],
      ),
    );
    if (chosen != null) await controller.recoverAndStart(chosen);
  }
}
