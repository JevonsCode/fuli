import '../api/fuli_api.dart';
import '../api/glance.dart';
import '../l10n/strings.dart';
import '../platform/ports.dart';
import 'fuli_condition.dart';

// 今天, where 等你拍板 lists the open requests (the console sends /workbench there).
const _todayLink = 'fuli://workbench';
// A menu line stays short: a subject or task title past this many characters
// is cut, and a project name past its own.
const _subjectChars = 24;
const _projectChars = 12;

/// The tray icon and its menu entries for the latest check. [canChangePort]
/// and [launchAtLogin] (null: not offered) come from the platform; [glance]
/// and [waitingRequests] are the work the menu shows, with times read at [now].
TrayView trayViewOf(FuliSnapshot? snapshot,
    {required bool busy,
    required Strings strings,
    bool canChangePort = false,
    bool? launchAtLogin,
    Glance? glance,
    int waitingRequests = 0,
    DateTime? now}) {
  if (snapshot == null) {
    return TrayView(icon: TrayIcon.needsPerson, tooltip: '${strings.appName} · ${strings.checking}',
        toggleLabel: strings.startFuli, toggleEnabled: false,
        changePortEnabled: canChangePort ? false : null, launchAtLogin: launchAtLogin);
  }
  return TrayView(
    icon: switch (snapshot.condition) {
      // A busy computer needs nothing from the person: the tooltip says it is slow.
      FuliCondition.ok || FuliCondition.busy => TrayIcon.ok,
      FuliCondition.needsPerson => TrayIcon.needsPerson,
      _ => TrayIcon.broken,
    },
    tooltip: '${strings.appName} · ${snapshot.sentence(strings)}',
    toggleLabel: snapshot.running ? strings.stopFuli : strings.startFuli,
    toggleEnabled: snapshot.installed && !busy,
    lines: _workLines(glance, waitingRequests, strings, now ?? DateTime.now()),
    changePortEnabled: canChangePort ? snapshot.installed && !busy : null,
    launchAtLogin: launchAtLogin,
  );
}

// The open requests first, then each section that has rows under its heading.
// A section without rows says nothing.
List<TrayLine> _workLines(Glance? glance, int waitingRequests, Strings strings, DateTime now) => [
      if (waitingRequests > 0)
        TrayLine(strings.requestsWaiting(waitingRequests, orMore: waitingRequests >= openAttentionLimit), link: _todayLink),
      if (glance != null) ...[
        ..._section(strings.assistantsAtWork, glance.assistants, strings,
            (row) => TrayLine(
                strings.assistantAtWork(row.name, _when(row, strings, now),
                    project: _cut(row.project, _projectChars), task: _cut(row.task, _subjectChars)),
                link: row.link)),
        ..._section(strings.roundtablesUnderWay, glance.roundtables, strings,
            (row) => TrayLine(strings.roundtableUnderWay(_cut(row.subject, _subjectChars)!, row.replying, row.waitingFor), link: row.link)),
      ],
    ];

List<TrayLine> _section<Row>(String heading, GlanceSection<Row> section, Strings strings, TrayLine Function(Row) line) => [
      if (section.rows.isNotEmpty) ...[
        TrayLine(heading),
        ...section.rows.map(line),
        if (section.more > 0 && section.link != null) TrayLine(strings.moreRows(section.more), link: section.link),
      ],
    ];

// At work now, or the local time its latest task began (the day before says so).
String _when(AssistantAtWork row, Strings strings, DateTime now) {
  if (row.working) return strings.workingNow;
  final at = row.at?.toLocal();
  if (at == null) return '';
  final clock = '${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}';
  return at.day == now.day ? clock : strings.yesterdayAt(clock);
}

String? _cut(String? text, int chars) {
  if (text == null) return null;
  final runes = text.runes.toList();
  return runes.length > chars ? '${String.fromCharCodes(runes.take(chars - 1)).trimRight()}…' : text;
}
