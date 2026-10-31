import '../api/fuli_api.dart';

/// Which open requests from Agents are new since the last check, so each one
/// is announced once. The first check only learns what is already open: the
/// window is showing then, and the console lists them.
class AttentionWatch {
  Set<String>? _known;

  List<AttentionNotice> observe(List<AttentionNotice> open) {
    final known = _known;
    _known = {for (final notice in open) notice.id};
    if (known == null) return const [];
    return [for (final notice in open) if (!known.contains(notice.id)) notice];
  }
}
