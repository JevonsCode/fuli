import '../doctor/doctor_report.dart';
import '../l10n/strings.dart';

// What the person sees first: one condition and one sentence for it.

enum FuliCondition { ok, needsPerson, degraded, notRunning, notFound }

/// How bad a condition is; a notification goes out only when this rises.
int conditionLevel(FuliCondition condition) => switch (condition) {
      FuliCondition.ok => 0,
      FuliCondition.needsPerson => 1,
      _ => 2,
    };

/// One picture of FULI from a single check.
class FuliSnapshot {
  const FuliSnapshot({
    required this.condition,
    required this.port,
    required this.installed,
    required this.running,
    this.items = const [],
    this.version,
    this.doctorUnsupported = false,
    this.problem,
    this.reached = true,
  });

  final FuliCondition condition;
  final int port;
  // A FULI installation this client can start and stop was found.
  final bool installed;
  final bool running;
  final List<DoctorItem> items;
  final String? version;
  // The console answered, but this FULI version has no doctor.
  final bool doctorUnsupported;
  // Why FULI cannot be used, in a sentence, when the console did not help.
  final String? problem;
  // Whether the console answered at all.
  final bool reached;

  List<DoctorItem> get autoItems => items.where((item) => item.fix == DoctorFix.auto).toList();
  int get attentionCount => items.where((item) => item.severity != DoctorSeverity.info).length;

  String sentence(Strings strings) => switch (condition) {
        FuliCondition.ok => strings.statusOk,
        FuliCondition.needsPerson => strings.statusNeedsPerson(attentionCount > 0 ? attentionCount : 1),
        FuliCondition.degraded => strings.statusDegraded,
        FuliCondition.notRunning => strings.statusNotRunning,
        FuliCondition.notFound => strings.statusNotFound,
      };
}

FuliCondition conditionOf(DoctorOverall overall) => switch (overall) {
      DoctorOverall.ok => FuliCondition.ok,
      DoctorOverall.needsPerson => FuliCondition.needsPerson,
      DoctorOverall.degraded => FuliCondition.degraded,
    };
