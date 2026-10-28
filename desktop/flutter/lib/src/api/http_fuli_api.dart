import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../doctor/doctor_report.dart';
import 'fuli_api.dart';
import 'migration_plan.dart';

const _readTimeout = Duration(seconds: 10);
// Repairing reconnects Agent clients; applying a migration backs up and rewrites stores.
const _repairTimeout = Duration(minutes: 2);
const _applyTimeout = Duration(minutes: 10);

/// The console's request policy (src/http/request-policy.js in the core)
/// accepts only Host `127.0.0.1:<port>`, refuses a foreign Origin and needs
/// JSON on POST. This client never sends an Origin header.
class HttpFuliApi implements FuliApi {
  HttpFuliApi({required this.port, required http.Client client}) : _client = client;

  final int port;
  final http.Client _client;

  String get _authority => '127.0.0.1:$port';

  @override
  Future<DoctorReport> doctor() async => DoctorReport.fromJson(await _get('/api/system/doctor'));

  @override
  Future<RepairOutcome> repair() async =>
      RepairOutcome.fromJson(await _post('/api/system/doctor/repair', const {}, _repairTimeout));

  @override
  Future<HealthInfo> health() async => HealthInfo.fromJson(await _get('/api/health'));

  @override
  Future<VersionInfo> version() async => VersionInfo.fromJson(await _get('/api/system/version'));

  @override
  Future<UpdateStatus> startUpdate() async {
    final status = UpdateStatus.fromJson(await _post('/api/system/update', const {}, _readTimeout));
    if (status == null) throw const FormatException('The update answer has no id or status.');
    return status;
  }

  @override
  Future<UpdateStatus?> readUpdate() async {
    final body = await _get('/api/system/update');
    return UpdateStatus.fromJson(body is Map ? body['update'] : null);
  }

  @override
  Future<MigrationPlan> migrationPlan() async => MigrationPlan.fromJson(await _get('/api/data-format'));

  @override
  Future<ApplyOutcome> applyMigration(String digest) async =>
      ApplyOutcome.fromJson(await _post('/api/data-format/apply', {'digest': digest}, _applyTimeout));

  Future<Object?> _get(String path) =>
      _send(() => _client.get(Uri.http(_authority, path), headers: {'host': _authority}), _readTimeout);

  Future<Object?> _post(String path, Object body, Duration timeout) => _send(
        () => _client.post(
          Uri.http(_authority, path),
          headers: {'host': _authority, 'content-type': 'application/json'},
          body: jsonEncode(body),
        ),
        timeout,
      );

  Future<Object?> _send(Future<http.Response> Function() request, Duration timeout) async {
    final http.Response response;
    try {
      response = await request().timeout(timeout);
    } on TimeoutException {
      throw const FuliUnreachable('timeout');
    } on http.ClientException catch (error) {
      throw FuliUnreachable(error.message);
    }
    final body = _decode(response);
    if (response.statusCode >= 200 && response.statusCode < 300) return body;
    final map = body is Map ? body : const {};
    final code = map['code'];
    final message = map['error'];
    throw FuliHttpError(
      response.statusCode,
      code: code is String ? code : null,
      message: message is String ? message : null,
    );
  }

  Object? _decode(http.Response response) {
    if (response.body.isEmpty) return null;
    try {
      return jsonDecode(utf8.decode(response.bodyBytes));
    } on FormatException {
      return null;
    }
  }
}
