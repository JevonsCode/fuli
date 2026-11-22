import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/app/fuli_controller.dart';
import 'package:fuli_desktop/src/l10n/strings.dart';
import 'package:fuli_desktop/src/runtime/fuli_runtime.dart';
import 'package:fuli_desktop/src/preview/demo_fuli.dart';
import 'package:fuli_desktop/src/runtime/runtime_output.dart';

import 'support/fakes.dart';

const zh = Strings(chinese: true);
const en = Strings(chinese: false);

// The ids src/local-runtime/startup-stage.js reports.
const stages = ['checking', 'first_setup', 'graph_runtime', 'graph_start', 'provider_wait', 'console_start', 'console_open'];

void main() {
  test('every step a start reports has a sentence in both languages', () {
    for (final stage in stages) {
      expect(zh.startupStage(stage), isNotNull, reason: stage);
      expect(en.startupStage(stage), isNotNull, reason: stage);
      expect(zh.startupStage(stage), endsWith('…'));
    }
    // A step a newer FULI reports keeps the plain sentence instead of an id.
    expect(zh.startupStage('a_step_this_version_does_not_know'), isNull);
    expect(zh.startupStage(null), isNull);
  });

  test('a slow step says how long it waited and what it is up against, never a guess', () {
    expect(zh.startupStageSlow('console_start', const Duration(seconds: 40)),
        '已经等了 40 秒。FULI 最多等 1 分钟，然后会告诉你卡在哪。可以先去忙别的，好了会自己进去。');
    expect(zh.startupStageSlow('first_setup', const Duration(minutes: 3)),
        startsWith('已经等了 3 分钟。第一次启动要下载并解压内置数据库'));
    expect(en.startupStageSlow('provider_wait', const Duration(seconds: 95)),
        startsWith('Waiting 1 min 35 s so far. FULI waits up to 2 minutes'));
    // An unknown step still says something true rather than nothing.
    expect(zh.startupStageSlow('a_step_this_version_does_not_know', const Duration(seconds: 20)),
        contains('已经等了 20 秒。'));
  });

  test('a controller line carries a step; the result line never does', () {
    expect(parseStageLine('{"stage":"provider_wait"}'), 'provider_wait');
    expect(parseStageLine('  {"stage":"console_start"}  '), 'console_start');
    expect(parseStageLine('{"ok":false,"status":"stopped","stage":"provider_wait"}'), isNull);
    expect(parseStageLine('Fuli local services started.'), isNull);
    expect(parseStageLine('{not json'), isNull);
  });

  test('a failed start carries the step that did not finish; a good one carries none', () {
    final failed = parseControllerReply('{"ok":false,"status":"stopped","stage":"provider_wait","error":"no answer"}');
    expect(failed.stage, 'provider_wait');
    final worked = parseControllerReply('{"ok":true,"status":"running","stage":"console_open"}');
    expect(worked.stage, isNull);
  });

  test('the window follows the steps the start reports and forgets them when it ends', () async {
    var clock = DateTime.utc(2026);
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.running))..stages = ['graph_start', 'provider_wait'];
    final controller = FuliController(
        apiFor: (_) => DemoFuliApi(), runtime: runtime, notifier: RecordingNotifier(), strings: zh,
        now: () => clock);
    addTearDown(controller.dispose);

    final seen = <String?>[];
    controller.addListener(() => seen.add(controller.startupStage));
    await controller.start();

    expect(seen, containsAllInOrder(<String?>['graph_start', 'provider_wait']));
    // The start is over: no step is shown any more.
    expect(controller.startupStage, isNull);
    expect(controller.startupWaited, isNull);
    clock = clock.add(const Duration(seconds: 30));
    expect(controller.startupWaited, isNull);
  });

  test('a start that fails names the step it stopped at', () async {
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, stage: 'provider_wait', error: 'no answer'))
      ..stages = ['graph_start', 'provider_wait'];
    final controller = FuliController(
        apiFor: (_) => DemoFuliApi(), runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    addTearDown(controller.dispose);

    await controller.start();
    expect(controller.notice?.error, isTrue);
    expect(controller.notice?.text, '没有启动成功，卡在「正在等 Provider 就绪」：no answer');
  });
}
