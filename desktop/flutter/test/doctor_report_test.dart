import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/doctor/doctor_report.dart';
import 'package:fuli_desktop/src/l10n/strings.dart';

void main() {
  const zh = Strings(chinese: true);
  const en = Strings(chinese: false);

  test('parses known and unknown kinds, ordering blocking items first', () {
    final report = DoctorReport.fromJson({
      'checkedAt': '2026-10-28T10:00:00Z',
      'version': '0.22.0',
      'overall': 'needs_person',
      'items': [
        {'id': 'u', 'kind': 'update_available', 'severity': 'info', 'fix': 'person', 'data': {'latest': '0.23.0'}},
        {'id': 'c', 'kind': 'client_outdated', 'severity': 'warning', 'fix': 'auto',
          'data': {'clientId': 'codex', 'label': 'Codex', 'status': 'outdated'}},
        {'id': 'f', 'kind': 'future_kind_from_newer_core', 'severity': 'blocking', 'fix': 'person', 'data': {'x': 1}},
      ],
    });

    expect(report.overall, DoctorOverall.needsPerson);
    expect(report.version, '0.22.0');
    expect(report.items.map((item) => item.id), ['f', 'c', 'u']);
    expect(report.items[1].fix, DoctorFix.auto);
    expect(report.items.first.kind, 'future_kind_from_newer_core');
  });

  test('a value a newer core adds never becomes automatic or breaks the report', () {
    final report = DoctorReport.fromJson({
      'overall': 'something_new',
      'items': [
        {'kind': 'client_outdated', 'severity': 'critical', 'fix': 'maybe'},
        'not an object',
        {'id': 'no-kind'},
      ],
    });

    expect(report.overall, DoctorOverall.needsPerson);
    expect(report.items, hasLength(1));
    expect(report.items.single.id, 'client_outdated#0');
    expect(report.items.single.severity, DoctorSeverity.warning);
    expect(report.items.single.fix, DoctorFix.person);
  });

  test('rejects an answer that is not an object', () {
    expect(() => DoctorReport.fromJson([1, 2]), throwsFormatException);
  });

  test('every known kind has its own sentence and an unknown kind a generic one', () {
    DoctorItem item(String kind, Map<String, Object?> data) =>
        DoctorItem(id: kind, kind: kind, severity: DoctorSeverity.warning, fix: DoctorFix.person, data: data);
    final generic = zh.explain(item('brand_new', const {}));
    final known = {
      'client_outdated': {'clientId': 'codex', 'label': 'Codex'},
      'data_format_waiting': {'store': 'tasks', 'label': 'Tasks', 'steps': ['tasks-v3']},
      'data_format_blocked': {'store': 'tasks'},
      'sessions_outdated': {'client': 'claude_code', 'count': 2, 'runningVersion': '0.21.0'},
      'update_available': {'latest': '0.23.0'},
      'update_left_work': {'clients': 'not_reconnected', 'version': '0.23.0'},
      'codex_hooks_review': <String, Object?>{},
    };
    for (final MapEntry(key: kind, value: data) in known.entries) {
      final sentence = zh.explain(item(kind, data));
      expect(sentence, isNot(generic), reason: kind);
      expect(sentence, isNot(contains(kind)), reason: 'raw code shown for $kind');
    }
    expect(generic, isNot(contains('brand_new')));
    expect(zh.explain(item('sessions_outdated', known['sessions_outdated']!)), contains('Claude Code'));
    expect(en.explain(item('update_available', const {'latest': '0.23.0'})), 'FULI v0.23.0 is available.');
    expect(en.explain(item('update_left_work', const {'status': 'failed', 'error': 'disk full'})),
        'The last update did not finish.');
  });
}
