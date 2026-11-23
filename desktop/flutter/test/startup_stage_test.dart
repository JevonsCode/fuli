import 'package:flutter_test/flutter_test.dart';
import 'package:fuli_desktop/src/app/fuli_controller.dart';
import 'package:fuli_desktop/src/l10n/strings.dart';
import 'package:fuli_desktop/src/preview/demo_fuli.dart';
import 'package:fuli_desktop/src/runtime/fuli_runtime.dart';
import 'package:fuli_desktop/src/runtime/runtime_output.dart';

import 'support/fakes.dart';

const zh = Strings(chinese: true);
const en = Strings(chinese: false);

// The ids src/local-runtime/startup-stage.js reports; test/startup-stage.test.js
// checks this file's switch names the same ones.
const stages = ['checking', 'first_setup', 'start_wait', 'graph_runtime', 'graph_install', 'graph_start',
  'database_wait', 'provider_wait', 'graph_setup', 'console_start', 'console_open'];

void main() {
  test('every step a start reports has a sentence in both languages', () {
    for (final stage in stages) {
      expect(zh.startupStage(stage), endsWith('…'), reason: stage);
      expect(en.startupStage(stage), endsWith('…'), reason: stage);
    }
    // A step a newer FULI reports keeps the plain sentence instead of an id.
    expect(zh.startupStage('a_step_this_version_does_not_know'), isNull);
    expect(zh.startupStage(null), isNull);
  });

  test('a slow step says how long it waited and the longest it will wait, from what the start reported', () {
    expect(zh.startupStageSlow(const Duration(seconds: 40), 60), '已经等了 40 秒。最多等 1 分钟。');
    expect(en.startupStageSlow(const Duration(seconds: 95), 240), 'Waiting 1 min 35 s so far. It waits up to 4 min.');
    // A wait without a fixed limit says only how long it has waited: nothing guessed.
    expect(zh.startupStageSlow(const Duration(minutes: 3), null), '已经等了 3 分钟。');
    // A screen reader hears the limit, not the seconds that change every few seconds.
    expect(zh.startupStageLimit(60), '最多等 1 分钟。');
    expect(zh.startupStageLimit(null), isNull);
  });

  test('a step line carries the step and its limit; the result line never does', () {
    expect(parseStageLine('{"stage":"provider_wait","maxSeconds":240}'), (stage: 'provider_wait', maxSeconds: 240));
    expect(parseStageLine('  {"stage":"console_start"}  '), (stage: 'console_start', maxSeconds: null));
    expect(parseStageLine('{"ok":false,"status":"stopped","stage":"provider_wait"}'), isNull);
    expect(parseStageLine('Fuli local services started.'), isNull);
    expect(parseStageLine('{not json'), isNull);
  });

  test('the reason a failed start names comes on its own stderr line and is kept apart', () {
    final read = readStartupFailure('没有启动：端口 7687 被另一个程序占着\n'
        'FULI_STARTUP_FAILURE {"code":"port_taken","port":7687,"pid":4321,"command":"java"}');
    expect(read.stderr, '没有启动：端口 7687 被另一个程序占着');
    expect(read.failure?.code, 'port_taken');
    expect(read.failure?.number('pid'), 4321);
    expect(readStartupFailure('plain error').failure, isNull);
    expect(readStartupFailure('FULI_STARTUP_FAILURE {not json').failure, isNull);
  });

  test('a controller reply carries the failure, the step that did not finish, and why a release kept the lock', () {
    final failed = parseControllerReply(
        '{"ok":false,"status":"stopped","stage":"provider_wait","failure":{"code":"native_lifecycle_lock","holder":"unknown"}}');
    expect(failed.stage, 'provider_wait');
    expect(failed.failure?.text('holder'), 'unknown');
    final kept = parseControllerReply('{"ok":false,"status":"stopped","lockRelease":{"released":false,"reason":"fuli_running","pid":77}}');
    expect(kept.lockKept?.code, 'fuli_running');
    expect(kept.lockKept?.number('pid'), 77);
    // A start that worked carries none of these, whatever else it says.
    final worked = parseControllerReply('{"ok":true,"status":"running","stage":"console_open","failure":{"code":"port_taken"}}');
    expect(worked.stage, isNull);
    expect(worked.failure, isNull);
  });

  test('every cause has a sentence in both languages, and none asks for a command or a hidden folder', () {
    const facts = <String, Object?>{'since': '2026-11-22T17:24:35.000Z', 'pid': 4321, 'port': 7687, 'command': 'java',
      'runningSeconds': 28800, 'seconds': 60, 'operation': 'update', 'phase': 'switching'};
    final cases = [
      for (final holder in ['running', 'gone', 'unknown']) StartupFailure('native_lifecycle_lock', {...facts, 'holder': holder}),
      for (final code in ['native_recovery_needed', 'port_taken', 'console_not_answering', 'console_exited',
        'console_port_reserved', 'provider_not_ready', 'provider_exited'])
        StartupFailure(code, facts),
      StartupFailure('console_not_answering', {...facts, 'stillRunningPid': 99}),
    ];
    for (final failure in cases) {
      for (final strings in [zh, en]) {
        final text = strings.startFailedBecause(failure)!;
        expect(text, isNot(contains('fuli ')), reason: '${failure.code} asks for no command');
        expect(text, isNot(contains('`')), reason: failure.code);
        expect(text, isNot(contains('.neo4j-lifecycle.lock')), reason: failure.code);
      }
    }
    expect(zh.startFailedBecause(const StartupFailure('made_up', {})), isNull);
  });

  test('the three holders of a lock, and a switch waiting for recovery, read differently and honestly', () {
    String said(Map<String, Object?> facts, [String code = 'native_lifecycle_lock']) =>
        zh.startFailedBecause(StartupFailure(code, {'since': '2026-11-22T17:24:35.000Z', 'pid': 4321, ...facts}))!;
    expect(said({'holder': 'running', 'command': 'node'}), contains('被进程 4321（node）占着'));
    expect(said({'holder': 'gone', 'operation': 'update'}), contains('中途停了'));
    expect(said({'holder': 'unknown'}), contains('没有记录是谁加的'));
    final recovery = said({'operation': 'update', 'phase': 'switching', 'fromVersion': '5.26.0', 'toVersion': '5.26.28', 'upgrade': true,
      'backupName': 'before-neo4j-5.26.28-2026-11-22T17-00-00-000Z'}, 'native_recovery_needed');
    expect(recovery, contains('有一次数据库更新（5.26.0 → 5.26.28）没做完'));
    expect(recovery, contains('FULI 没有复制或替换知识数据文件，但切换途中新版本的数据库可能已经打开过它们'));
    expect(recovery, contains('backups/graph/before-neo4j-5.26.28-'));
    expect(recovery, contains('不要删除数据库维护锁'));
    expect(recovery, isNot(contains('没有被覆盖')));
    expect(recovery, isNot(contains('解除')), reason: 'never a reason to release the lock');
    expect(said({'operation': 'uninstall', 'phase': 'removing-assets'}, 'native_recovery_needed'), contains('知识数据文件没有被改动'));
    // What an interrupted operation can have changed: a load may have half written the database.
    expect(said({'holder': 'gone', 'operation': 'load'}), contains('数据库可能只写入了一半'));
    expect(said({'holder': 'gone', 'operation': 'load'}), isNot(contains('没有被改动')));
    expect(said({'holder': 'gone', 'operation': 'dump'}), contains('导出只读数据库'));
    expect(said({'holder': 'gone', 'operation': 'update'}), contains('点「恢复并启动」'));
    // 恢复 covers a switch journal and a lock an operation left; never a lock whose holder runs or that names none.
    expect(zh.recoverable(const StartupFailure('native_recovery_needed', {})), isTrue);
    expect(zh.recoverable(const StartupFailure('native_lifecycle_lock', {'holder': 'gone'})), isTrue);
    expect(zh.recoverable(const StartupFailure('native_lifecycle_lock', {'holder': 'running'})), isFalse);
    expect(zh.recoverable(const StartupFailure('native_lifecycle_lock', {'holder': 'unknown'})), isFalse);
    // Only a lock no holder is recorded for may be released by a person; never a
    // running holder's, nor one an update left (half-installed files).
    expect(zh.releasableLock(const StartupFailure('native_lifecycle_lock', {'holder': 'unknown'})), isTrue);
    expect(zh.releasableLock(const StartupFailure('native_lifecycle_lock', {'holder': 'running'})), isFalse);
    expect(zh.releasableLock(const StartupFailure('native_recovery_needed', {'holder': 'unknown'})), isFalse);
  });

  test('the port holder is named with how long it has run', () {
    expect(zh.startFailedBecause(const StartupFailure('port_taken', {'port': 7687, 'pid': 4321, 'command': 'java', 'runningSeconds': 28800})),
        startsWith('没有启动：端口 7687 被另一个程序占着（进程 4321 · java，已运行 8 小时）'));
  });

  test('the window follows the steps the start reports and forgets them when it ends', () async {
    var clock = DateTime.utc(2026);
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.running))..stages = ['graph_start', 'provider_wait'];
    final controller = FuliController(
        apiFor: (_) => DemoFuliApi(), runtime: runtime, notifier: RecordingNotifier(), strings: zh, now: () => clock);
    addTearDown(controller.dispose);

    final seen = <String?>[];
    controller.addListener(() => seen.add(controller.startupStage));
    await controller.start();

    expect(seen, containsAllInOrder(<String?>['graph_start', 'provider_wait']));
    expect(controller.startupStage, isNull);
    expect(controller.startupMaxSeconds, isNull);
    clock = clock.add(const Duration(seconds: 30));
    expect(controller.startupWaited, isNull);
  });

  test('a start stopped at a lock nobody holds offers the release; a release that keeps it says why', () async {
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, error: 'lock',
        failure: StartupFailure('native_lifecycle_lock', {'since': '2026-11-22T17:24:35.000Z', 'holder': 'unknown'})))
      ..releaseReport = const RuntimeReport(RuntimeState.stopped, error: 'kept',
          lockKept: StartupFailure('fuli_running', {'reason': 'fuli_running', 'pid': 77}));
    final controller = FuliController(apiFor: (_) => DemoFuliApi(), runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    addTearDown(controller.dispose);
    await controller.start();
    expect(controller.releasableLock, isTrue);
    expect(controller.notice?.text, contains('没有记录是谁加的'));
    expect(controller.notice?.logDirectory, '/fuli-data/logs');

    await controller.releaseLockAndStart();
    expect(runtime.calls, contains('release-lock-start'));
    expect(controller.notice?.text, '锁没有解除：另一个 FULI 命令（进程 77）正在用这份数据。');
  });

  test('every reason a release keeps the lock is said in one language, never as "it changed"', () {
    for (final reason in ['recovery_needed', 'holder_running', 'services_running', 'fuli_running', 'cannot_inspect', 'too_recent',
      'no_lock', 'asset_operation', 'unfinished_assets']) {
      final text = zh.lockKept(StartupFailure(reason, const {'pid': 7, 'operation': 'update', 'releasableAt': '2026-11-23T03:00:00.000Z'}));
      expect(text, isNot(contains('换掉')), reason: reason);
      expect(text, isNot(contains(' / ')), reason: reason);
    }
    expect(zh.lockKept(const StartupFailure('asset_operation', {'operation': 'load'})), contains('一次数据库导入留下的'));
  });

  test('a recovery plan and every reason it will not run are said in one language', () {
    for (final kind in ['undo_switch', 'finish_switch', 'back_out_switch', 'finish_uninstall', 'clear_interrupted', 'release_dump', 'restore_load']) {
      final words = zh.recoveryPlanWords(RecoveryPlan(kind, const [{'do': 'move-aside', 'path': '/x/neo4j-assets/jvs-a-1'}, {'do': 'release-lock'}], 'd', const {}));
      expect(words.first, isNot(kind), reason: kind);
      expect(words.join(), isNot(contains(' / ')), reason: kind);
    }
    expect(zh.recoveryPlanWords(const RecoveryPlan('clear_interrupted', [{'do': 'move-aside', 'path': '/x/neo4j-assets/jvs-a-1'}], 'd', {}))[1],
        '· 把 jvs-a-1 移到 recovered 文件夹（不删）');
    for (final reason in ['holder_running', 'fuli_running', 'cannot_inspect', 'manifest_changed', 'unknown_assets', 'no_restore_point', 'plan_changed']) {
      expect(zh.recoveryRefused(reason, 7), startsWith('没有恢复：'), reason: reason);
    }
  });

  test('a start stopped at a lock an update left offers no release', () async {
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, error: 'lock',
        failure: StartupFailure('native_lifecycle_lock', {'holder': 'gone', 'operation': 'update', 'pid': 9})));
    final controller = FuliController(apiFor: (_) => DemoFuliApi(), runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    addTearDown(controller.dispose);
    await controller.start();
    expect(controller.releasableLock, isFalse);
    await controller.releaseLockAndStart();
    expect(runtime.calls, isNot(contains('release-lock-start')));
  });

  test('a stopped FULI whose automatic restarts gave up says so', () async {
    final api = DemoFuliApi()..reachable = false;
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, autostartGaveUpAt: '2026-11-22T18:05:25.972Z'));
    final controller = FuliController(apiFor: (_) => api, runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    addTearDown(controller.dispose);
    await controller.refresh();
    expect(controller.snapshot?.problem, startsWith('自动重启已经停了：'));
    expect(parseCliStatus('{"status":"stopped","console":{"status":"stopped"},"autostart":{"gaveUp":true,"at":"2026-11-22T18:05:25.972Z"}}')
        .autostartGaveUpAt, '2026-11-22T18:05:25.972Z');
  });

  test('a start that fails names the step it stopped at', () async {
    final runtime = FixedRuntime(const RuntimeReport(RuntimeState.stopped, stage: 'provider_wait', error: 'no answer'))
      ..stages = ['graph_start', 'provider_wait'];
    final controller = FuliController(apiFor: (_) => DemoFuliApi(), runtime: runtime, notifier: RecordingNotifier(), strings: zh);
    addTearDown(controller.dispose);
    await controller.start();
    expect(controller.notice?.error, isTrue);
    expect(controller.notice?.text, '没有启动成功，卡在「正在等 Provider 就绪」：no answer');
  });
}
