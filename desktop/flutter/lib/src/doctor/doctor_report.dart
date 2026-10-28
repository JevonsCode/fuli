// The FULI core's health check (GET /api/system/doctor). Parsing is lenient:
// a newer FULI may add kinds, severities or fields, and the client must keep
// showing what it understands instead of failing the whole report.

enum DoctorOverall { ok, needsPerson, degraded }

enum DoctorSeverity { info, warning, blocking }

enum DoctorFix { auto, person }

class DoctorItem {
  const DoctorItem({
    required this.id,
    required this.kind,
    required this.severity,
    required this.fix,
    this.data = const {},
  });

  final String id;
  // Kept as text: a kind this client does not know still gets a card.
  final String kind;
  final DoctorSeverity severity;
  final DoctorFix fix;
  final Map<String, Object?> data;

  static DoctorItem? fromJson(Object? json, int index) {
    if (json is! Map) return null;
    final kind = json['kind'];
    if (kind is! String || kind.isEmpty) return null;
    final id = json['id'];
    final data = json['data'];
    return DoctorItem(
      id: id is String && id.isNotEmpty ? id : '$kind#$index',
      kind: kind,
      severity: switch (json['severity']) {
        'info' => DoctorSeverity.info,
        'blocking' => DoctorSeverity.blocking,
        _ => DoctorSeverity.warning,
      },
      // Only an explicit "auto" is repaired without the person deciding.
      fix: json['fix'] == 'auto' ? DoctorFix.auto : DoctorFix.person,
      data: data is Map ? data.map((key, value) => MapEntry('$key', value)) : const {},
    );
  }
}

class DoctorReport {
  const DoctorReport({required this.overall, required this.items, this.version});

  final DoctorOverall overall;
  final List<DoctorItem> items;
  final String? version;

  static DoctorReport fromJson(Object? json) {
    if (json is! Map) throw const FormatException('The doctor answer is not a JSON object.');
    final rawItems = json['items'];
    final items = <DoctorItem>[];
    if (rawItems is List) {
      for (var index = 0; index < rawItems.length; index++) {
        final item = DoctorItem.fromJson(rawItems[index], index);
        if (item != null) items.add(item);
      }
    }
    items.sort((a, b) => b.severity.index.compareTo(a.severity.index));
    final version = json['version'];
    return DoctorReport(
      overall: switch (json['overall']) {
        'ok' => DoctorOverall.ok,
        'degraded' => DoctorOverall.degraded,
        // needs_person, or a value a newer FULI added: ask the person to look.
        _ => DoctorOverall.needsPerson,
      },
      items: List.unmodifiable(items),
      version: version is String ? version : null,
    );
  }
}
