import 'package:fuli_desktop/src/platform/ports.dart';
import 'package:fuli_desktop/src/runtime/fuli_runtime.dart';

class RecordingNotifier implements Notifier {
  final List<String> bodies = [];

  @override
  Future<void> notify(String title, String body) async => bodies.add(body);
}

class RecordingOpener implements UrlOpener {
  final List<Uri> opened = [];

  @override
  Future<void> open(Uri uri) async => opened.add(uri);
}

/// A runtime whose answers the test sets directly.
class FixedRuntime implements FuliRuntime {
  FixedRuntime(this.report, {this.port = 4100});

  RuntimeReport report;
  final int port;
  final List<String> calls = [];

  @override
  Future<bool> locate() async => report.state != RuntimeState.notFound;

  @override
  Future<int> consolePort() async => port;

  @override
  Future<RuntimeReport> status() async {
    calls.add('status');
    return report;
  }

  @override
  Future<RuntimeReport> start() async {
    calls.add('start');
    return report;
  }

  @override
  Future<RuntimeReport> stop() async {
    calls.add('stop');
    return report;
  }

  @override
  bool get canChangePort => true;

  @override
  Future<RuntimeReport> changePort() async {
    calls.add('change-port');
    return report;
  }
}
