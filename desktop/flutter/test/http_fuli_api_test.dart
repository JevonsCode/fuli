import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/api/fuli_api.dart';
import 'package:fuli_desktop/src/api/http_fuli_api.dart';
import 'package:fuli_desktop/src/api/migration_plan.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

// A mock HTTP client only: no socket, no real console port.
void main() {
  const port = 4517;
  final requests = <http.Request>[];

  HttpFuliApi apiAnswering(http.Response Function(http.Request request) answer) {
    requests.clear();
    return HttpFuliApi(
      port: port,
      client: MockClient((request) async {
        requests.add(request);
        return answer(request);
      }),
    );
  }

  http.Response json(Object body, [int status = 200]) =>
      http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

  test('sends the loopback Host the console requires and never an Origin', () async {
    final api = apiAnswering((_) => json({'overall': 'ok', 'items': [], 'version': '0.22.0'}));
    final report = await api.doctor();

    expect(report.version, '0.22.0');
    final request = requests.single;
    expect(request.url.toString(), 'http://127.0.0.1:$port/api/system/doctor');
    expect(request.headers['host'], '127.0.0.1:$port');
    expect(request.headers.keys.map((key) => key.toLowerCase()), isNot(contains('origin')));
  });

  test('POSTs JSON bodies with a JSON content type', () async {
    final api = apiAnswering((request) => switch (request.url.path) {
          '/api/system/doctor/repair' => json({
              'results': [
                {'id': 'a', 'outcome': 'fixed'},
                {'id': 'b', 'outcome': 'failed', 'error': 'Codex config is read-only'},
                {'id': 'c', 'outcome': 'skipped'},
              ],
              'doctor': {'overall': 'ok', 'items': []},
            }),
          '/api/data-format/apply' => json({'status': 'applied', 'results': []}),
          _ => json({'id': 'u1', 'status': 'updating', 'step': null}),
        });

    final repair = await api.repair();
    expect(repair.fixed, 1);
    expect(repair.failures, ['Codex config is read-only']);
    expect(requests.single.body, '{}');
    expect(requests.single.headers['content-type'], startsWith('application/json'));

    expect((await api.applyMigration('a' * 64)).state, ApplyState.applied);
    expect(jsonDecode(requests.last.body), {'digest': 'a' * 64});

    final update = await api.startUpdate();
    expect(update.state, UpdateState.updating);
    expect(requests.last.url.path, '/api/system/update');
  });

  test('a missing doctor is a 404 the controller can fall back on', () async {
    final api = apiAnswering((_) => json({'error': 'Not found'}, 404));
    await expectLater(api.doctor(), throwsA(isA<FuliHttpError>().having((error) => error.status, 'status', 404)));
  });

  test('a refused preview keeps its code', () async {
    final api = apiAnswering((_) => json({'error': 'The plan changed', 'code': 'data_format_stale_preview'}, 409));
    await expectLater(
      api.applyMigration('b' * 64),
      throwsA(isA<FuliHttpError>().having((error) => error.code, 'code', 'data_format_stale_preview')),
    );
  });

  test('a closed port is unreachable, not an error answer', () async {
    final api = HttpFuliApi(port: port, client: MockClient((_) async => throw http.ClientException('refused')));
    await expectLater(api.health(), throwsA(isA<FuliUnreachable>()));
  });

  test('reads the update status and the migration preview', () async {
    final api = apiAnswering((request) => switch (request.url.path) {
          '/api/system/update' => json({
              'update': {'id': 'u1', 'status': 'failed', 'step': 'verifying', 'error': 'checksum mismatch'},
            }),
          _ => json({
              'digest': 'c' * 64,
              'stores': [
                {
                  'label': 'Tasks', 'store': 'tasks', 'kind': 'sqlite', 'action': 'apply', 'automatic': [],
                  'step': {'id': 'tasks-v3', 'summary': 'Adds a status', 'kind': 'x', 'fromVersion': 2, 'toVersion': 3,
                    'count': 7, 'sampleIds': ['t1', 't2']},
                  'undo': 'restore_only', 'warning': 'Deletes 2 drafts', 'digest': 'd' * 64,
                },
              ],
              'blocked': [{'label': 'Graph', 'store': 'graph', 'action': 'blocked', 'steps': [], 'reason': 'Graph offline'}],
              'undoable': [],
            }),
        });

    final update = await api.readUpdate();
    expect(update!.state, UpdateState.failed);
    expect(update.error, 'checksum mismatch');

    final plan = await api.migrationPlan();
    expect(plan.digest, 'c' * 64);
    final store = plan.stores.single;
    expect([store.label, store.summary, store.fromVersion, store.toVersion, store.count], ['Tasks', 'Adds a status', 2, 3, 7]);
    expect(store.undoAvailable, isFalse);
    expect(store.warning, 'Deletes 2 drafts');
    expect(plan.blocked.single.reason, 'Graph offline');
  });
}
