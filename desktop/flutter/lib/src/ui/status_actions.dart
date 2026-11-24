import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

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
          // After a start an unfinished import refused, its way out is typed in
          // Terminal: the commands with their real paths, to copy, are a click here.
          if (!snapshot.running && controller.pending == null && controller.unfinishedImportCommands.isNotEmpty)
            TextButton.icon(
              key: const Key('unfinished-import-commands'),
              onPressed: () => _showUnfinishedImport(context),
              icon: const Icon(Icons.terminal_rounded, size: 16),
              label: Text(strings.showCommands),
            )
          // After a start that failed, the start's log is a click here.
          else if (_startupLog case final folder?)
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
    // The import's own copy cannot be used: giving the import up is the way on,
    // a choice of its own, never 「恢复并启动」.
    if (!snapshot.running && controller.abandonableImport) {
      return OutlinedButton(
        key: const Key('abandon-import'),
        onPressed: busy ? null : () => _confirmAbandon(context),
        child: Text(strings.abandonImport),
      );
    }
    // The last start stopped at a graph service of this data FULI lost track of: the one way on, confirmed first.
    if (!snapshot.running && controller.orphanedServices.isNotEmpty) {
      return FilledButton(
        key: const Key('end-orphans-start'),
        onPressed: busy ? null : () => _confirmEndOrphans(context),
        child: Text(strings.endOrphansAndStart),
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

  Future<void> _confirmEndOrphans(BuildContext context) async {
    final services = controller.orphanedServices.map((service) => strings.orphanedService(service.port, service.command));
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(strings.endOrphansTitle),
        content: Text(strings.endOrphansBody(services.join(strings.chinese ? '、' : ', '))),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: Text(strings.cancel)),
          FilledButton(
            key: const Key('end-orphans-confirm'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(strings.endOrphansAndStart),
          ),
        ],
      ),
    );
    if (confirmed == true) await controller.endOrphansAndStart();
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
    // Finishing without a start check: only when the plan says going back is
    // not possible or was tried (neo4j-recovery.js `keepable`), a choice of its own.
    final keepable = plan.kind == 'finish_switch' && plan.facts['keepable'] == true;
    // A good copy that would not go back: abandoning the import is open beside trying again.
    final abandonable = plan.kind == 'restore_load' && plan.facts['restoreFailed'] is Map;
    if (controller.recoversInTerminal) {
      return _showInTerminal(context, plan, [_command(plan), if (alternative != null) _command(alternative),
        if (keepable) 'fuli graph runtime recover --keep-newer', if (abandonable) 'fuli graph runtime recover --abandon-import']);
    }
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
          if (keepable)
            OutlinedButton(
              key: const Key('keep-newer'),
              onPressed: () => Navigator.of(dialogContext).pop(const RecoveryPlan('keep_newer', [], null, {})),
              child: Text(strings.keepNewer(plan.facts)),
            ),
          if (abandonable)
            OutlinedButton(
              key: const Key('abandon-import'),
              onPressed: () => Navigator.of(dialogContext).pop(const RecoveryPlan('abandon_load', [], null, {})),
              child: Text(strings.abandonImport),
            ),
          if (alternative != null)
            OutlinedButton(
              key: const Key('recover-alternative'),
              onPressed: () => Navigator.of(dialogContext).pop(alternative),
              child: Text(alternative.kind == 'back_out_switch' ? strings.cancelSwitch(plan.facts) : strings.finishSwitchTo(plan.facts)),
            ),
          FilledButton(
            key: const Key('recover-confirm'),
            onPressed: () => Navigator.of(dialogContext).pop(plan),
            child: Text(switching && alternative != null
                ? (plan.kind == 'finish_switch' ? strings.finishSwitchTo(plan.facts) : strings.cancelSwitch(plan.facts))
                : plan.steps.any((step) => step['do'] == 'end-holders')
                    ? strings.endHoldersAndRetry
                    : strings.recoveryConfirm),
          ),
        ],
      ),
    );
    if (chosen == null || !context.mounted) return;
    if (chosen.kind == 'keep_newer') return _confirmKeepNewer(context);
    if (chosen.kind == 'abandon_load' && chosen.digest == null) return _confirmAbandon(context);
    await controller.recoverAndStart(chosen);
    if (context.mounted) await _showKeptGraphData(context);
  }

  // Keeping the newer version: what it does, why it did not start and what is
  // open afterwards come first; then its own confirmation.
  Future<void> _confirmKeepNewer(BuildContext context) async {
    final plan = await controller.previewRecovery(keepNewer: true);
    if (plan == null || !context.mounted) return;
    final why = controller.lastFailure;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(strings.keepNewerTitle(plan.facts)),
        content: SingleChildScrollView(
            child: SelectableText([
          if (why != null) strings.recoveryRefused(why.text('reason'), why.facts),
          ...strings.recoveryPlanWords(plan),
        ].join('\n'))),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: Text(strings.cancel)),
          FilledButton(
            key: const Key('keep-newer-confirm'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(strings.keepNewerConfirm),
          ),
        ],
      ),
    );
    if (confirmed == true) await controller.recoverAndStart(plan, keepNewer: true);
  }

  // Graph data a recovery moved aside stays until the person deletes it: where
  // it is, how big, which graphs, and the commands that move it back (copyable).
  Future<void> _showKeptGraphData(BuildContext context) async {
    final folders = controller.keptGraphData;
    if (folders.isEmpty) return;
    final words = strings.keptGraphDataWords(folders).join('\n');
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(strings.keptGraphDataTitle),
        content: SingleChildScrollView(child: SelectableText(words, key: const Key('kept-graph-data'))),
        actions: [
          TextButton(onPressed: () => Clipboard.setData(ClipboardData(text: words)), child: Text(strings.copyCommand)),
          FilledButton(onPressed: () => Navigator.of(dialogContext).pop(), child: Text(strings.close)),
        ],
      ),
    );
  }

  // An unfinished import's way out (src/backup/unfinished-import.js): why the
  // start was refused, then each command the CLI wrote for this computer's
  // terminal, with its real paths, each with its own copy button.
  Future<void> _showUnfinishedImport(BuildContext context) => showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text(strings.unfinishedImportTitle),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (controller.notice case final notice?) SelectableText(notice.text),
                for (final (index, entry) in controller.unfinishedImportCommands.indexed) ...[
                  const SizedBox(height: FuliSpace.space4),
                  Text(entry.label, style: TypeScale.secondary),
                  SelectableText(entry.command, key: ValueKey('unfinished-import-command $index')),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton(
                      key: ValueKey('copy-unfinished-import-command $index'),
                      onPressed: () => Clipboard.setData(ClipboardData(text: entry.command)),
                      child: Text(strings.copyCommand),
                    ),
                  ),
                ],
              ],
            ),
          ),
          actions: [FilledButton(onPressed: () => Navigator.of(dialogContext).pop(), child: Text(strings.close))],
        ),
      );

  // Giving up the import: what happens to which graphs and how to import back
  // come first; its button says it empties them.
  Future<void> _confirmAbandon(BuildContext context) async {
    final plan = await controller.previewRecovery(abandonImport: true);
    if (plan == null || !context.mounted) return;
    if (controller.recoversInTerminal) return _showInTerminal(context, plan, [_command(plan)]);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(strings.abandonImportTitle),
        content: SingleChildScrollView(child: SelectableText(strings.recoveryPlanWords(plan).join('\n'))),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: Text(strings.cancel)),
          FilledButton(
            key: const Key('abandon-import-confirm'),
            style: FilledButton.styleFrom(backgroundColor: FuliColors.danger),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(strings.abandonImportConfirm),
          ),
        ],
      ),
    );
    if (confirmed == true) await controller.recoverAndStart(plan, abandonImport: true);
    if (confirmed == true && context.mounted) await _showKeptGraphData(context);
  }

  // The `fuli` CLI recovers only at a terminal: the plan, and the command to
  // run there (copyable), with no button that would do nothing.
  Future<void> _showInTerminal(BuildContext context, RecoveryPlan plan, List<String> commands) => showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text(strings.recoveryInTerminalTitle),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text([...strings.recoveryPlanWords(plan), '', strings.recoveryInTerminal].join('\n')),
                const SizedBox(height: FuliSpace.space4),
                for (final command in commands) SelectableText(command, key: ValueKey('recovery-command $command')),
              ],
            ),
          ),
          actions: [
            TextButton(
              key: const Key('copy-recovery-command'),
              onPressed: () => Clipboard.setData(ClipboardData(text: commands.first)),
              child: Text(strings.copyCommand),
            ),
            FilledButton(onPressed: () => Navigator.of(dialogContext).pop(), child: Text(strings.close)),
          ],
        ),
      );

  // The terminal command that does [plan] (src/cli/native-runtime-command.js).
  String _command(RecoveryPlan plan) => switch (plan.kind) {
        'abandon_load' => 'fuli graph runtime recover --abandon-import',
        'back_out_switch' => 'fuli graph runtime recover --back-out',
        _ => 'fuli graph runtime recover',
      };
}
