import 'package:flutter/material.dart';

import '../api/fuli_api.dart';
import '../api/migration_plan.dart';
import '../app/fuli_controller.dart';
import '../l10n/strings.dart';
import 'pending_line.dart';
import 'theme.dart';

const _staleCode = 'data_format_stale_preview';
const _shortDigest = 12;
const _shownSamples = 3;

/// What a data format change rewrites, read from the console before the
/// person confirms; the confirmation applies exactly the plan whose digest
/// was shown. The core checks the digest again and refuses a changed plan.
class MigrationDialog extends StatefulWidget {
  const MigrationDialog({super.key, required this.controller, required this.strings});

  final FuliController controller;
  final Strings strings;

  @override
  State<MigrationDialog> createState() => _MigrationDialogState();
}

class _MigrationDialogState extends State<MigrationDialog> {
  MigrationPlan? _plan;
  String? _error;
  bool _loading = true;
  bool _applying = false;
  bool _stale = false;
  ApplyOutcome? _outcome;

  Strings get s => widget.strings;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final plan = await widget.controller.migrationPlan();
      if (mounted) setState(() => _plan = plan);
    } on Exception catch (error) {
      if (mounted) setState(() => _error = s.migrationLoadFailed('$error'));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _apply(String digest) async {
    setState(() {
      _applying = true;
      _stale = false;
      _error = null;
    });
    try {
      final outcome = await widget.controller.applyMigration(digest);
      if (mounted) setState(() => _outcome = outcome);
    } on FuliHttpError catch (error) {
      if (error.code == _staleCode) {
        if (mounted) setState(() => _stale = true);
        await _load();
      } else if (mounted) {
        setState(() => _error = s.actionFailed('$error'));
      }
    } on Exception catch (error) {
      if (mounted) setState(() => _error = s.actionFailed('$error'));
    } finally {
      if (mounted) setState(() => _applying = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final plan = _plan;
    final digest = plan?.digest;
    final done = _outcome != null;
    return AlertDialog(
      title: Text(s.migrationTitle, style: TypeScale.section),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(child: _body(plan)),
      ),
      actions: [
        TextButton(
          onPressed: _applying ? null : () => Navigator.of(context).pop(),
          child: Text(done ? s.close : s.cancel),
        ),
        if (!done && digest != null && plan!.stores.isNotEmpty)
          FilledButton(
            onPressed: _applying || _loading ? null : () => _apply(digest),
            child: Text(s.migrationConfirm),
          ),
      ],
    );
  }

  Widget _body(MigrationPlan? plan) {
    if (_loading && plan == null) return PendingLine(label: s.migrationLoading);
    final outcome = _outcome;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (outcome != null)
          _line(outcome.state == ApplyState.applied ? s.migrationApplied : s.migrationNotApplied(outcome.failures.join('; ')),
              error: outcome.state != ApplyState.applied)
        else ...[
          if (_stale) _line(s.migrationStale, error: true),
          if (plan != null) ..._planView(plan),
        ],
        if (_applying) PendingLine(label: s.migrationApplying),
        if (_error != null) _line(_error!, error: true),
      ],
    );
  }

  List<Widget> _planView(MigrationPlan plan) {
    if (plan.stores.isEmpty && plan.blocked.isEmpty) return [_line(s.migrationNothing)];
    return [
      Text(s.migrationIntro, style: TypeScale.secondary),
      const SizedBox(height: 16),
      for (final store in plan.stores) ...[_storeView(store), const SizedBox(height: 12)],
      if (plan.blocked.isNotEmpty) ...[
        Text(s.migrationBlocked, style: TypeScale.cardTitle),
        const SizedBox(height: 6),
        for (final store in plan.blocked) Text('${store.label} · ${store.reason}', style: TypeScale.secondary),
        const SizedBox(height: 12),
      ],
      if (plan.digest != null)
        Text(s.migrationDigest(plan.digest!.substring(0, plan.digest!.length.clamp(0, _shortDigest))),
            style: TypeScale.meta),
    ];
  }

  Widget _storeView(MigrationStore store) {
    final samples = store.sampleIds.take(_shownSamples).join(', ');
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: Palette.surfaceSubtle, borderRadius: BorderRadius.circular(12)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(store.label, style: TypeScale.cardTitle),
          if (store.summary.isNotEmpty) Text(store.summary, style: TypeScale.body),
          const SizedBox(height: 4),
          Text(s.migrationStoreLine(store.fromVersion, store.toVersion, store.count), style: TypeScale.secondary),
          if (samples.isNotEmpty) Text('${s.migrationSamples}: $samples', style: TypeScale.meta),
          Text(store.undoAvailable ? s.migrationUndoAvailable : s.migrationUndoRestoreOnly, style: TypeScale.meta),
          if (store.warning != null) ...[
            const SizedBox(height: 6),
            Text(store.warning!, style: TypeScale.secondary.copyWith(color: Palette.danger)),
          ],
        ],
      ),
    );
  }

  Widget _line(String text, {bool error = false}) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Text(text, style: TypeScale.body.copyWith(color: error ? Palette.danger : Palette.ink)),
      );
}
