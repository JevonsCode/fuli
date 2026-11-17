import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/api/glance.dart';
import 'package:fuli_desktop/src/app/fuli_condition.dart';
import 'package:fuli_desktop/src/app/tray_view.dart';
import 'package:fuli_desktop/src/l10n/strings.dart';
import 'package:fuli_desktop/src/platform/ports.dart';

// The lines of work in the tray menu, from synthetic rows.
void main() {
  const zh = Strings(chinese: true);
  const en = Strings(chinese: false);
  const running = FuliSnapshot(condition: FuliCondition.ok, port: 2727, installed: true, running: true);
  final now = DateTime(2026, 11, 16, 14, 30);

  List<(String, String?)> lines(Strings strings, {Glance? glance, int waitingRequests = 0}) => [
        for (final line in trayViewOf(running, busy: false, strings: strings, glance: glance, waitingRequests: waitingRequests, now: now).lines)
          (line.label, line.link),
      ];

  test('a FULI with nothing going on adds no line to the menu', () {
    expect(lines(zh), isEmpty);
    expect(lines(zh, glance: const Glance(assistants: GlanceSection([]), roundtables: GlanceSection([]))), isEmpty);
    expect(trayViewOf(null, busy: false, strings: zh, waitingRequests: 2).lines, isEmpty);
  });

  test('the open requests come first, then who worked and the roundtables under way, each under its heading', () {
    final glance = Glance(
      assistants: GlanceSection([
        const AssistantAtWork(name: 'Synthetic Lead', working: true, link: 'fuli://agents/s/lead'),
        AssistantAtWork(name: 'Synthetic Tester', working: false, at: DateTime(2026, 11, 16, 9, 5), link: 'fuli://agents/s/tester'),
        AssistantAtWork(name: 'Synthetic Night', working: false, at: DateTime(2026, 11, 15, 21, 40), link: 'fuli://agents/s/night'),
        const AssistantAtWork(name: 'Synthetic Timeless', working: false, link: 'fuli://agents/s/timeless'),
      ], more: 2, link: 'fuli://project-agents'),
      roundtables: const GlanceSection([
        RoundtableUnderWay(subject: 'Review round', replying: true, waitingFor: ['Synthetic Tester'], link: 'fuli://roundtables/t1'),
        RoundtableUnderWay(subject: 'A handoff subject that is far too long', replying: false, waitingFor: ['Synthetic Lead', 'Synthetic Night'], link: 'fuli://roundtables/t2'),
        RoundtableUnderWay(subject: 'Unnamed ask', replying: false, waitingFor: [], link: 'fuli://roundtables/t3'),
      ]),
    );

    expect(lines(zh, glance: glance, waitingRequests: 2), [
      ('2 个请求等你处理', 'fuli://workbench'),
      ('近 24 小时干过活的助手', null),
      ('Synthetic Lead · 进行中', 'fuli://agents/s/lead'),
      ('Synthetic Tester · 09:05', 'fuli://agents/s/tester'),
      ('Synthetic Night · 昨天 21:40', 'fuli://agents/s/night'),
      ('Synthetic Timeless', 'fuli://agents/s/timeless'),
      ('还有 2 个…', 'fuli://project-agents'),
      ('圆桌讨论中', null),
      ('Review round · 回复中', 'fuli://roundtables/t1'),
      ('A handoff subject that… · 等 Synthetic Lead、Synthetic Night', 'fuli://roundtables/t2'),
      ('Unnamed ask · 等回复', 'fuli://roundtables/t3'),
    ]);
    expect(lines(en, glance: glance, waitingRequests: 1).map((line) => line.$1), [
      '1 request is waiting for you',
      'Assistants at work in the last 24 hours',
      'Synthetic Lead · working now',
      'Synthetic Tester · 09:05',
      'Synthetic Night · yesterday 21:40',
      'Synthetic Timeless',
      '2 more…',
      'Roundtables under way',
      'Review round · replying',
      'A handoff subject that… · waiting for Synthetic Lead, Synthetic Night',
      'Unnamed ask · waiting for a reply',
    ]);
  });

  test('as many open requests as the client reads are shown as that many or more', () {
    expect(lines(zh, waitingRequests: 19).single.$1, '19 个请求等你处理');
    expect(lines(zh, waitingRequests: 20).single.$1, '20+ 个请求等你处理');
    expect(lines(en, waitingRequests: 20).single.$1, '20+ requests are waiting for you');
  });

  test('a menu whose lines changed is a different view, so the tray shows it', () {
    TrayView view({required bool working}) => trayViewOf(running, busy: false, strings: zh, now: now,
        glance: Glance(
            assistants: GlanceSection([AssistantAtWork(name: 'Synthetic Lead', working: working, link: 'fuli://agents/s/lead')]),
            roundtables: const GlanceSection([])));
    expect(view(working: true), view(working: true));
    expect(view(working: true), isNot(view(working: false)));
  });
}
