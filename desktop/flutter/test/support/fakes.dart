import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';
import 'package:fuli_desktop/src/platform/caption_controls.dart';
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

/// The window caption, recording what the window was asked to do.
class RecordingCaption implements CaptionControls {
  RecordingCaption({this.platform = 'windows'});

  final calls = <String>[];
  final placed = <(Rect, Size)>[];

  @override
  final String platform;

  @override
  bool get drawsButtons => platform == 'windows';

  @override
  ({double start, double end}) get reserved => drawsButtons ? (start: 0, end: 138) : (start: 76, end: 0);

  @override
  final ValueNotifier<bool> maximized = ValueNotifier(false);

  @override
  final ValueNotifier<NativeButtonState> maximizeButtonState = ValueNotifier(NativeButtonState.idle);

  @override
  Future<void> minimize() async => calls.add('minimize');

  @override
  Future<void> toggleMaximize() async => calls.add('toggleMaximize');

  @override
  Future<void> close() async => calls.add('close');

  @override
  Future<void> startDragging() async => calls.add('startDragging');

  @override
  Future<void> showWindowMenu() async => calls.add('showWindowMenu');

  @override
  void placeMaximizeButton(Rect button, Size window) => placed.add((button, window));
}
