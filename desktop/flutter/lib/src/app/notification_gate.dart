import 'fuli_condition.dart';

/// Decides when FULI getting worse is worth one OS notification: only on a
/// change to a worse condition, never twice for the same condition until FULI
/// was fine again, and not for the first check (the window is open then).
class NotificationGate {
  FuliCondition? _last;
  FuliCondition? _notified;

  /// Records [condition] and returns whether to notify. [quiet] records a
  /// change the person caused (stopping FULI) without notifying about it.
  bool observe(FuliCondition condition, {bool quiet = false}) {
    final previous = _last;
    _last = condition;
    if (conditionLevel(condition) == 0) {
      _notified = null;
      return false;
    }
    if (previous == null || quiet) {
      _notified = condition;
      return false;
    }
    if (conditionLevel(condition) <= conditionLevel(previous) || condition == _notified) return false;
    _notified = condition;
    return true;
  }
}
