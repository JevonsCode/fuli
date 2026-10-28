// What GET /api/data-format previews before the person confirms a data format
// change (src/data-format/migration-plan.js in the core): stores, steps, record
// counts and sample IDs, never record content. Apply sends back its digest.

class MigrationStore {
  const MigrationStore({
    required this.label,
    required this.summary,
    required this.fromVersion,
    required this.toVersion,
    required this.count,
    required this.sampleIds,
    required this.undoAvailable,
    this.warning,
  });

  final String label;
  final String summary;
  final int? fromVersion;
  final int? toVersion;
  final int count;
  final List<String> sampleIds;
  final bool undoAvailable;
  // What no undo brings back (a step that deletes).
  final String? warning;
}

class BlockedStore {
  const BlockedStore({required this.label, required this.reason});
  final String label;
  final String reason;
}

class MigrationPlan {
  const MigrationPlan({required this.digest, required this.stores, required this.blocked});

  final String? digest;
  final List<MigrationStore> stores;
  final List<BlockedStore> blocked;

  static MigrationPlan fromJson(Object? json) {
    final map = json is Map ? json : const {};
    final digest = map['digest'];
    return MigrationPlan(
      digest: digest is String && digest.isNotEmpty ? digest : null,
      stores: [for (final store in _maps(map['stores'])) _store(store)],
      blocked: [
        for (final store in _maps(map['blocked']))
          BlockedStore(label: _text(store['label']) ?? _text(store['store']) ?? '', reason: _text(store['reason']) ?? ''),
      ],
    );
  }

  static MigrationStore _store(Map store) {
    final step = store['step'] is Map ? store['step'] as Map : const {};
    final samples = step['sampleIds'];
    return MigrationStore(
      label: _text(store['label']) ?? _text(store['store']) ?? '',
      summary: _text(step['summary']) ?? _text(step['id']) ?? '',
      fromVersion: step['fromVersion'] is int ? step['fromVersion'] as int : null,
      toVersion: step['toVersion'] is int ? step['toVersion'] as int : null,
      count: step['count'] is int ? step['count'] as int : 0,
      sampleIds: samples is List ? samples.whereType<String>().toList() : const [],
      undoAvailable: store['undo'] == 'available',
      warning: _text(store['warning']),
    );
  }
}

enum ApplyState { applied, partial, failed }

class ApplyOutcome {
  const ApplyOutcome({required this.state, required this.failures});
  final ApplyState state;
  // "label: message" for each store that was not applied.
  final List<String> failures;

  static ApplyOutcome fromJson(Object? json) {
    final map = json is Map ? json : const {};
    return ApplyOutcome(
      state: switch (map['status']) {
        'applied' => ApplyState.applied,
        'partial' => ApplyState.partial,
        _ => ApplyState.failed,
      },
      failures: [
        for (final result in _maps(map['results']))
          if (result['status'] == 'failed')
            '${_text(result['label']) ?? ''}: ${_text(result['message']) ?? _text(result['code']) ?? ''}',
      ],
    );
  }
}

Iterable<Map> _maps(Object? value) => value is List ? value.whereType<Map>() : const [];

String? _text(Object? value) => value is String && value.isNotEmpty ? value : null;
