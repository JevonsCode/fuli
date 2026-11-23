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
      'runningSeconds': 28800, 'seconds': 60, 'operation': 'update', 'phase': 'switching',
      'services': [
        {'port': 7687, 'command': 'java'}
      ]};
    final cases = [
      for (final holder in ['running', 'gone', 'unknown']) StartupFailure('native_lifecycle_lock', {...facts, 'holder': holder}),
      for (final code in ['native_recovery_needed', 'orphaned_graph_service', 'port_taken', 'console_not_answering', 'console_exited',
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

  test('a recovery plan and every reason it will not run are said in one language, with a next step', () {
    for (final kind in ['undo_switch', 'finish_switch', 'back_out_switch', 'continue_back_out', 'finish_uninstall', 'clear_interrupted', 'release_dump',
      'restore_load', 'finish_recovery', 'abandon_load']) {
      final words = zh.recoveryPlanWords(RecoveryPlan(kind, const [{'do': 'move-aside', 'path': '/x/neo4j-assets/jvs-a-1', 'bytes': 3 * 1024 * 1024}, {'do': 'release-lock'}], 'd', const {}));
      expect(words.first, isNot(kind), reason: kind);
      expect(words.join(), isNot(contains(' / ')), reason: kind);
    }
    expect(zh.recoveryPlanWords(const RecoveryPlan('clear_interrupted', [{'do': 'move-aside', 'path': '/x/neo4j-assets/jvs-a-1', 'bytes': 3145728}], 'd', {}))[1],
        '· 把一份数据库程序（jvs-a-1，3.0 MB）移到 recovered 文件夹，不删除');
    // A load says when its copy is from, what it covers, and that the import is not kept.
    final load = zh.recoveryPlanWords(const RecoveryPlan('restore_load', [{'do': 'restore', 'from': '/x/b', 'instances': ['personal']}], 'd', {
      'restorePoint': {'path': '/x/b', 'createdAt': '2026-11-22T00:00:00.000Z', 'instances': ['personal']},
      'emptied': ['workspace'],
    })).join('\n');
    expect(load, contains('这次想导入的内容不会保留，之后需要重新导入'));
    expect(load, contains('自动留下的备份恢复 个人图谱'));
    expect(load, contains('工作区图谱 在导入前是空的'));
    // Finishing a switch shows where the backup is, and the other way out.
    final finish = RecoveryPlan('finish_switch', const [], 'd', const {'operation': 'update', 'fromVersion': '5.26.0', 'toVersion': '5.26.28',
      'fromLabel': '5.26.0', 'toLabel': '5.26.28', 'backupPath': '/x/before-neo4j', 'alternative': {'kind': 'back_out_switch', 'steps': [], 'digest': 'e'}});
    expect(zh.recoveryPlanWords(finish).first, startsWith('完成这次没做完的更新，改用 5.26.28'));
    expect(zh.recoveryPlanWords(finish).join(), contains('升级前的图备份在 /x/before-neo4j'));
    expect(finish.alternative?.digest, 'e');
    expect(zh.recoveryAlternativeWords(finish), contains('也可以取消更新、留在 5.26.0'));
    expect([zh.finishSwitchTo(finish.facts), zh.cancelSwitch(finish.facts)], ['完成更新，改用 5.26.28 并启动', '取消更新，留在 5.26.0 并启动']);
    expect(zh.recoveryAlternativeWords(const RecoveryPlan('finish_switch', [], 'd', {'operation': 'update', 'fromVersion': '5.26.0', 'alternativeRefused': 'no_fingerprint'})),
        contains('不能取消更新、回到 5.26.0'));
    // An unfinished rollback: its target is the kept older programs, so it is worded as a rollback with each side's programs, never newer / older.
    const rollbackFacts = {'operation': 'rollback', 'fromVersion': '5.26.28', 'toVersion': '5.26.28',
      'fromLabel': 'neo4j-assets/jvs-a-2', 'toLabel': 'neo4j-assets/jvs-a-1',
      'fromInstalledAt': '2026-11-20T06:00:00.000Z', 'toInstalledAt': '2026-10-02T06:00:00.000Z'};
    final rollback = RecoveryPlan('finish_switch', const [{'do': 'check-start', 'version': '5.26.28'}], 'd', const {...rollbackFacts,
      'alternative': {'kind': 'back_out_switch', 'steps': [], 'digest': 'e'}});
    final rollbackWords = [...zh.recoveryPlanWords(rollback), zh.recoveryAlternativeWords(rollback)!, zh.finishSwitchTo(rollback.facts), zh.cancelSwitch(rollback.facts),
      zh.recoveryRefused('start_failed', const {...rollbackFacts, 'planKind': 'back_out_switch', 'keepable': true})].join('\n');
    // Each side by which copy of the programs it is and when it was installed, never the hashed directory.
    expect(rollbackWords, matches(RegExp('完成这次没做完的回退，改用 5.26.28（更新前保留的那一份程序，安装于 [^）]+）')));
    expect(rollbackWords, matches(RegExp('取消回退，留在 5.26.28（回退前在用的那一份程序，安装于 [^）]+） 并启动')));
    expect(rollbackWords, isNot(contains('jvs-a-')));
    expect(rollbackWords, isNot(matches(RegExp('新版本|旧版本|升级前'))));
    final rollbackEn = [...en.recoveryPlanWords(rollback), en.finishSwitchTo(rollback.facts), en.cancelSwitch(rollback.facts)].join('\n');
    expect(rollbackEn, contains('Finish the unfinished rollback to 5.26.28 (the programs kept from before the update, installed '));
    expect(rollbackEn, contains('stay on 5.26.28 (the programs in use before the rollback, installed '));
    // Without an install time, each side still says which copy it is, then its directory.
    expect(zh.cancelSwitch({...rollbackFacts, 'fromInstalledAt': null}), '取消回退，留在 5.26.28（回退前在用的那一份程序，neo4j-assets/jvs-a-2） 并启动');
    expect(en.cancelSwitch({...rollbackFacts, 'fromInstalledAt': null}), 'Cancel the rollback, stay on 5.26.28 (the programs in use before the rollback, neo4j-assets/jvs-a-2) and start');
    expect(rollbackEn, isNot(matches(RegExp(r'\bnewer\b|\bolder\b'))));
    for (final reason in ['holder_running', 'fuli_running', 'cannot_inspect', 'no_holder', 'too_recent', 'cannot_stop_services', 'manifest_changed',
      'unknown_journal', 'unmanaged_path', 'assets_changed', 'unknown_assets', 'no_fingerprint', 'format_changed', 'format_unreadable', 'start_failed',
      'restore_failed', 'restore_point_unknown', 'restore_point_damaged', 'restore_point_usable', 'no_import', 'lock_changed', 'step_failed', 'plan_changed',
      'recovery_running', 'keep_newer_unavailable', 'back_out_available']) {
      final said = zh.recoveryRefused(reason, const {'pid': 7, 'directory': 'neo4j-assets/jvs-a-1', 'step': 'restore'});
      expect(said, matches(RegExp('^没有(恢复|放弃|解锁)：')), reason: reason);
      expect(said, isNot(contains(reason)), reason: reason);
      expect(said, isNot(contains('fuli ')), reason: '$reason: never a command to type');
    }
    // After a refusal that can pass, 恢复并启动 stays; one about the lock's holder offers the unlock.
    expect(zh.recoverable(const StartupFailure('recovery_refused', {'reason': 'restore_failed'})), isTrue);
    expect(zh.recoverable(const StartupFailure('recovery_refused', {'reason': 'manifest_changed'})), isFalse);
    expect(zh.releasableLock(const StartupFailure('recovery_refused', {'reason': 'no_holder'})), isTrue);
    // An import whose copy cannot be used offers abandoning it, never 恢复并启动 again.
    for (final reason in ['restore_point_unknown', 'restore_point_damaged']) {
      expect(zh.abandonableImport(StartupFailure('recovery_refused', {'reason': reason})), isTrue, reason: reason);
      expect(zh.recoverable(StartupFailure('recovery_refused', {'reason': reason})), isFalse, reason: reason);
    }
    // Abandoning says why the copy cannot be used, what ends up empty, and the copies an import can bring back.
    final abandon = zh.recoveryPlanWords(const RecoveryPlan('abandon_load', [], 'd', {
      'copyProblem': 'damaged', 'backupPath': '/x/b', 'instances': ['personal', 'workspace'], 'allInstances': true, 'dataDir': '/x',
      'written': ['personal'], 'unsure': ['workspace'], 'untouched': [], 'folder': '/x/native-runtime/recovered/t',
      'moveBack': [{'from': '/x/native-runtime/recovered/t/personal/data/databases/neo4j', 'to': '/x/native-runtime/personal/data/databases/neo4j'}],
      'copies': [{'path': '/x/backups/graph/before-import-0', 'createdAt': '2026-11-20T00:00:00.000Z', 'bytes': 2048, 'instances': ['personal']}],
    })).join('\n');
    expect(abandon, contains('已损坏（读不出或校验和不对）：/x/b'));
    expect(abandon, contains('每个图谱都按文件的修改时间判断'));
    expect(abandon, contains('个人图谱：看文件的修改时间，导入开始后它的库被写过，可能只写了一半'));
    expect(abandon, contains('工作区图谱：判断不了它有没有被这次导入写过，为安全起见一起挪开，不删除'));
    expect(abandon, contains('确认之后，再点「恢复并启动」只会接着把放弃做完，不会再自动导回'));
    expect(abandon, contains('mv "/x/native-runtime/recovered/t/personal/data/databases/neo4j" "/x/native-runtime/personal/data/databases/neo4j"'));
    expect(abandon, contains('fuli graph import --input "/x/backups/graph/before-import-0" --data-dir "/x" --yes'));
    // Abandoning after an import that stopped half way through one graph: the one it finished holds the new data, and says so.
    final judged = zh.recoveryPlanWords(const RecoveryPlan('abandon_load', [], 'd', {
      'copyProblem': 'restore_failed', 'backupPath': '/x/b', 'dataDir': '/x', 'halfWritten': ['workspace'], 'imported': ['personal'],
      'restoreUnfinished': ['personal'], 'beforeImport': [], 'inCopy': ['personal'], 'restoreFailed': {'detail': 'No space left on device', 'freeBytes': 1024, 'leastBytes': 4096,
        'holders': [{'pid': 66, 'name': 'java'}]},
      'copies': [{'path': '/x/b', 'createdAt': '2026-11-20T00:00:00.000Z', 'bytes': 2048, 'instances': ['personal']}],
    })).join('\n');
    expect(judged, contains('副本是好的（校验和对得上）：/x/b，但把它导回没有成功：No space left on device。磁盘剩余 1.0 KB，导回至少需要 4.0 KB。还有进程在用图谱的目录：66（java），可能是 FULI 之前没关掉的数据库；先在「活动监视器」里结束它'));
    expect(judged, contains('个人图谱：把它从这次导入前的副本导回时停下了（被打断或没有成功），可能只写了一半。继续的话会变成空的'));
    expect(judged, contains('原因解决后，可以用下面这次导入前的副本把它导回'));
    expect(judged, contains('工作区图谱：这次导入写它的时候停下了（被打断或失败）'));
    expect(judged, contains('fuli graph import --input "/x/b"'));
    expect(zh.abandonableImport(const StartupFailure('recovery_refused', {'reason': 'restore_failed'})), isTrue);
    expect(zh.recoveryRefused('restore_failed', const {'detail': 'No space left on device', 'freeBytes': 1024, 'leastBytes': 4096, 'backupPath': '/x/b'}),
        allOf(contains('磁盘剩余 1.0 KB'), contains('副本本身是好的：/x/b'), contains('「放弃这次导入…」')));
    // Clearing old recovery folders says it deletes them, by the rule the plan carries.
    expect(zh.recoveryPlanWords(const RecoveryPlan('release_dump', [{'do': 'prune', 'path': '/x/recovered/a', 'bytes': 1024, 'keepDays': 40, 'keepRuns': 4}], 'd', {}))[1],
        contains('永久删除一个旧的恢复文件夹（a，1.0 KB：只有数据库程序和记录，没有图谱数据；超过 40 天，之后又有至少 4 次恢复'));
    // A newer version that did not start: the other way only when it is there, and always the way out of keeping it.
    final alone = zh.recoveryRefused('start_failed', const {'planKind': 'finish_switch', 'alternativeRefused': 'no_fingerprint', 'toVersion': '5.26.28',
      'startFailure': {'message': 'no answer', 'failure': {'code': 'port_taken', 'port': 7687, 'pid': 55}, 'logs': ['/x/personal/logs']}});
    expect(alone, isNot(contains('取消')));
    expect(alone, isNot(contains('完成切换并解除这把锁')), reason: 'finishing without a start check only when the plan says it is open');
    final keepable = zh.recoveryRefused('start_failed', const {'planKind': 'finish_switch', 'alternativeRefused': 'no_fingerprint', 'operation': 'update',
      'fromVersion': '5.26.0', 'toVersion': '5.26.28', 'keepable': true});
    expect(keepable, contains('「完成更新并解除这把锁…」：不做启动检查，之后不能再回到 5.26.0'));
    // Going back stopped at the store format, which the programs now in effect could not read: why, and that keeping is open.
    final unreadable = {'operation': 'update', 'fromVersion': '5.26.0', 'toVersion': '5.26.28', 'keepable': true, 'backOutFailed': 'format_unreadable'};
    expect(zh.recoveryRefused('start_failed', {...unreadable, 'planKind': 'finish_switch'}), contains('取消更新没有走通：读不出存储格式'));
    expect(zh.recoveryPlanWords(RecoveryPlan('finish_switch', const [], 'd', unreadable)).join(), contains('上次取消更新、回到 5.26.0 没有走通：读不出存储格式'));
    expect(zh.recoveryAlternativeWords(const RecoveryPlan('finish_switch', [], 'd', {'operation': 'update', 'fromVersion': '5.26.0', 'alternativeRefused': 'format_unreadable'})),
        contains('读它用的是现在生效的这一份程序和 Java'));
    expect(alone, contains('端口 7687 被进程 55 占着'));
    expect(alone, contains('日志在 /x/personal/logs'));
    expect(zh.recoveryRefused('start_failed', const {'planKind': 'finish_switch', 'alternative': 'back_out_switch', 'operation': 'update', 'fromVersion': '5.26.0'}),
        contains('取消更新、留在 5.26.0'));
    expect(zh.stoppedSwitch(const StartupFailure('recovery_refused', {'reason': 'start_failed', 'planKind': 'finish_switch'})), isTrue);
    expect(zh.stoppedSwitch(const StartupFailure('recovery_refused', {'reason': 'format_changed', 'planKind': 'back_out_switch'})), isTrue);
    expect(zh.stoppedSwitch(const StartupFailure('recovery_refused', {'reason': 'restore_failed', 'planKind': 'restore_load'})), isFalse);
    expect(zh.recoverable(const StartupFailure('recovery_refused', {'reason': 'format_changed', 'planKind': 'finish_switch'})), isTrue,
        reason: 'trying again and keeping the newer version both sit behind 恢复并启动');
    // Keeping the newer version says what is open afterwards, with the backup and the command that imports it.
    final keep = zh.recoveryPlanWords(const RecoveryPlan('keep_newer', [{'do': 'archive-journal'}, {'do': 'release-lock'}], 'd',
      {'operation': 'update', 'fromVersion': '5.26.0', 'toVersion': '5.26.28', 'backupPath': '/x/before-neo4j'})).join('\n');
    expect(keep, contains('完成这次没做完的更新，留在 5.26.28，并解除这把锁'));
    expect(keep, contains('不能再取消这次更新回到 5.26.0'));
    expect(keep, contains('fuli graph import --input "/x/before-neo4j" --yes'));
    // Graph data a recovery moved aside: where, how big, which graphs, how to move it back.
    final kept = zh.keptGraphDataWords(const [{'path': '/x/recovered/t', 'bytes': 2048, 'instances': ['workspace'],
      'stores': [{'from': '/x/recovered/t/workspace/data/databases/neo4j', 'to': '/x/workspace/data/databases/neo4j'}]}]).join('\n');
    expect(kept, contains('/x/recovered/t · 2.0 KB · 工作区图谱'));
    expect(kept, contains('mv "/x/recovered/t/workspace/data/databases/neo4j" "/x/workspace/data/databases/neo4j"'));
    expect(kept, contains('自动清理不会删它们'));
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
