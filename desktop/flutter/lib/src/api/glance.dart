// What GET /api/desktop/glance answers (src/desktop-glance/glance.js in the
// core): the few rows the tray menu shows of FULI's work. A row this client
// cannot read is left out; a section it cannot read is empty.

class Glance {
  const Glance({required this.assistants, required this.roundtables});

  /// The assistants that worked in the last 24 hours, the ones at work now first.
  final GlanceSection<AssistantAtWork> assistants;

  /// The roundtable threads with an ask still open.
  final GlanceSection<RoundtableUnderWay> roundtables;

  static Glance fromJson(Object? json) {
    final map = json is Map ? json : const {};
    return Glance(
      assistants: GlanceSection.fromJson(map['assistants'], AssistantAtWork.fromJson),
      roundtables: GlanceSection.fromJson(map['roundtables'], RoundtableUnderWay.fromJson),
    );
  }
}

/// A few rows, how many more the console has, and the `fuli://` page of them all.
class GlanceSection<Row> {
  const GlanceSection(this.rows, {this.more = 0, this.link});
  final List<Row> rows;
  final int more;
  final String? link;

  static GlanceSection<Row> fromJson<Row>(Object? json, Row? Function(Map row) read) {
    final map = json is Map ? json : const {};
    final rows = map['rows'];
    final more = map['more'];
    final link = map['link'];
    return GlanceSection(
      [for (final row in rows is List ? rows : const []) if (row is Map) ?read(row)],
      more: more is int && more > 0 ? more : 0,
      link: link is String ? link : null,
    );
  }
}

class AssistantAtWork {
  const AssistantAtWork({required this.name, required this.working, required this.link, this.at, this.project, this.task});
  final String name;

  /// The project of the task it is on, and a short title of that task; null when not known.
  final String? project;
  final String? task;

  /// A task it began is under way.
  final bool working;
  final String link;

  /// When its latest task began.
  final DateTime? at;

  static AssistantAtWork? fromJson(Map row) {
    final name = row['name'];
    final link = row['link'];
    if (name is! String || name.isEmpty || link is! String) return null;
    final at = row['at'];
    return AssistantAtWork(
      name: name,
      working: row['working'] == true,
      link: link,
      at: at is String ? DateTime.tryParse(at) : null,
      project: _text(row['project']),
      task: _text(row['task']),
    );
  }
}

String? _text(Object? value) => value is String && value.isNotEmpty ? value : null;

class RoundtableUnderWay {
  const RoundtableUnderWay({required this.subject, required this.replying, required this.waitingFor, required this.link});
  final String subject;

  /// An assistant is answering right now.
  final bool replying;

  /// Who the open asks are addressed to.
  final List<String> waitingFor;
  final String link;

  static RoundtableUnderWay? fromJson(Map row) {
    final subject = row['subject'];
    final link = row['link'];
    if (subject is! String || subject.isEmpty || link is! String) return null;
    final waitingFor = row['waitingFor'];
    return RoundtableUnderWay(
      subject: subject,
      replying: row['replying'] == true,
      waitingFor: [...(waitingFor is List ? waitingFor : const []).whereType<String>()],
      link: link,
    );
  }
}
