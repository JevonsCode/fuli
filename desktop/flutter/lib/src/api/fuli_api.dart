import '../doctor/doctor_report.dart';
import 'migration_plan.dart';

// The FULI console's HTTP API as this client uses it. Implementations talk to
// one console address; the controller asks for a new one when the port moves.
abstract interface class FuliApi {
  /// Throws [FuliHttpError] with status 404 when this FULI has no doctor yet.
  Future<DoctorReport> doctor();
  Future<RepairOutcome> repair();
  Future<HealthInfo> health();
  Future<VersionInfo> version();
  Future<UpdateStatus> startUpdate();
  Future<UpdateStatus?> readUpdate();
  Future<MigrationPlan> migrationPlan();
  Future<ApplyOutcome> applyMigration(String digest);

  /// Requests Agents left for the person that are still open, newest first.
  Future<List<AttentionNotice>> openAttention();
}

/// One open request from an Agent, as much as a notification shows.
class AttentionNotice {
  const AttentionNotice({required this.id, required this.title});
  final String id;
  final String title;

  static List<AttentionNotice> listFromJson(Object? json) {
    final items = json is Map ? json['items'] : null;
    if (items is! List) return const [];
    return [
      for (final item in items)
        if (item is Map && item['requestId'] is String && item['title'] is String)
          AttentionNotice(id: item['requestId'] as String, title: item['title'] as String),
    ];
  }
}

/// The console did not answer at all (not running, port closed, timed out).
class FuliUnreachable implements Exception {
  const FuliUnreachable(this.reason);
  final String reason;
  @override
  String toString() => reason;
}

/// The console answered with an error status.
class FuliHttpError implements Exception {
  const FuliHttpError(this.status, {this.code, this.message});
  final int status;
  final String? code;
  final String? message;
  @override
  String toString() => message ?? 'HTTP $status';
}

class HealthInfo {
  const HealthInfo({required this.ready, this.version});
  final bool ready;
  final String? version;

  static HealthInfo fromJson(Object? json) {
    final map = json is Map ? json : const {};
    final version = map['version'];
    return HealthInfo(ready: map['status'] == 'ready', version: version is String ? version : null);
  }
}

class VersionInfo {
  const VersionInfo({this.current, this.latest, this.updateAvailable = false});
  final String? current;
  final String? latest;
  final bool updateAvailable;

  static VersionInfo fromJson(Object? json) {
    final map = json is Map ? json : const {};
    final current = map['currentVersion'];
    final latest = map['latestVersion'];
    return VersionInfo(
      current: current is String ? current : null,
      latest: latest is String ? latest : null,
      updateAvailable: map['updateAvailable'] == true,
    );
  }
}

enum UpdateState { updating, updated, unchanged, failed }

class UpdateStatus {
  const UpdateStatus({required this.id, required this.state, this.step, this.version, this.error});
  final String id;
  final UpdateState state;
  // downloading / verifying / exitingTray / installing, as the core reports it.
  final String? step;
  // The version installed once the update finished.
  final String? version;
  final String? error;

  static UpdateStatus? fromJson(Object? json) {
    if (json is! Map) return null;
    final id = json['id'];
    final state = switch (json['status']) {
      'updating' => UpdateState.updating,
      'updated' => UpdateState.updated,
      'unchanged' => UpdateState.unchanged,
      'failed' => UpdateState.failed,
      _ => null,
    };
    if (id is! String || state == null) return null;
    final step = json['step'];
    final version = json['version'];
    final error = json['error'];
    return UpdateStatus(
      id: id,
      state: state,
      step: step is String ? step : null,
      version: version is String ? version : null,
      error: error is String ? error : null,
    );
  }
}

/// What POST /api/system/doctor/repair did; the controller checks again
/// afterwards instead of trusting the returned report.
class RepairOutcome {
  const RepairOutcome({required this.fixed, required this.failures});
  final int fixed;
  // The reason of each repair that failed (skipped repairs are not failures).
  final List<String> failures;

  static RepairOutcome fromJson(Object? json) {
    final map = json is Map ? json : const {};
    final results = map['results'] is List ? (map['results'] as List).whereType<Map>() : const <Map>[];
    return RepairOutcome(
      fixed: results.where((result) => result['outcome'] == 'fixed').length,
      failures: [
        for (final result in results)
          if (result['outcome'] != 'fixed' && result['outcome'] != 'skipped')
            result['error'] is String ? result['error'] as String : '${result['id'] ?? ''}',
      ],
    );
  }
}
