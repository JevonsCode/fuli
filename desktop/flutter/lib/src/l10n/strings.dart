import '../doctor/doctor_report.dart';
import '../runtime/fuli_runtime.dart';

// Every sentence the client shows, in Chinese and English, chosen once from
// the system locale. Each entry keeps both languages side by side.
class Strings {
  const Strings({required this.chinese});

  factory Strings.forLanguage(String languageCode) => Strings(chinese: languageCode == 'zh');

  final bool chinese;

  String _t(String zh, String en) => chinese ? zh : en;
  String _things(int count) => count == 1 ? '1 thing' : '$count things';

  // Status sentence
  // The desktop client is the main way to install FULI: its window and tray carry the plain name.
  String get appName => 'FULI';
  String get checking => _t('正在检查 FULI…', 'Checking FULI…');
  // The console answers; its page is loading in the window.
  String get openingConsole => _t('正在打开控制台…', 'Opening the console…');
  String get statusOk => _t('FULI 正常工作', 'FULI is working');
  String statusNeedsPerson(int count) =>
      _t('有 $count 件事需要你', count == 1 ? '1 thing needs you' : '$count things need you');
  String get statusDegraded => _t('FULI 现在不能正常使用', 'FULI cannot work properly right now');
  String get statusNotRunning => _t('FULI 没有运行', 'FULI is not running');
  String get statusNotFound => _t('没有找到 FULI', 'FULI was not found');
  String installedVersion(String version) => _t('已安装 v$version', 'Installed v$version');

  // Details under the status sentence
  String get doctorUnsupported =>
      _t('这个版本的 FULI 还不支持体检，更新后可用', 'This FULI version cannot run the health check yet; it can after an update');
  String get noAnswer => _t('FULI 在运行，但控制台没有应答。', 'FULI is running, but its console does not answer.');
  String consoleError(String detail) => _t('控制台回答出错：$detail', 'The console answered with an error: $detail');

  // A file the console exported, saved by the client
  String get fileSaved => _t('已保存到下载文件夹', 'Saved to Downloads');

  // A request an Agent left for the person
  String get attentionTitle => _t('Agent 需要你', 'An Agent needs you');
  String attentionMany(int count) =>
      _t('$count 个新的请求等你处理', '$count new requests are waiting for you');

  // Buttons and menu
  String get autoRepair => _t('自动修复', 'Fix automatically');
  String get review => _t('查看并确认', 'Review and confirm');
  String updateTo(String version) => _t('更新到 v$version', 'Update to v$version');
  String get openConsole => _t('打开控制台', 'Open console');
  String get startFuli => _t('启动 FULI', 'Start FULI');
  String get stopFuli => _t('停止 FULI', 'Stop FULI');
  String get restartFuli => _t('重启 FULI', 'Restart FULI');
  String get recheck => _t('重新检查', 'Check again');
  String get openFuli => _t('打开 FULI', 'Open FULI');
  String get quit => _t('退出', 'Quit');
  String get exportDiagnostics => _t('导出诊断包…', 'Export diagnostics bundle…');
  String get installPage => _t('打开安装页', 'Open the install page');
  // Tray menu: what FULI is doing. [orMore]: the count is the most this client reads.
  String requestsWaiting(int count, {required bool orMore}) => _t(
      '${orMore ? '$count+' : count} 个请求等你处理',
      orMore || count != 1 ? '$count${orMore ? '+' : ''} requests are waiting for you' : '1 request is waiting for you');
  String get assistantsAtWork => _t('近 24 小时干过活的助手', 'Assistants at work in the last 24 hours');
  String get workingNow => _t('进行中', 'working now');
  String yesterdayAt(String clock) => _t('昨天 $clock', 'yesterday $clock');
  // Name · project：task · when. [project] and [task] are null and [when] is
  // empty when not known; what is not known is left out.
  String assistantAtWork(String name, String when, {String? project, String? task}) {
    final work = project != null && task != null ? '$project${_t('：', ': ')}$task' : project ?? task;
    return [name, ?work, if (when.isNotEmpty) when].join(' · ');
  }
  String get roundtablesUnderWay => _t('圆桌讨论中', 'Roundtables under way');
  String roundtableUnderWay(String subject, bool replying, List<String> waitingFor) {
    final state = replying
        ? _t('回复中', 'replying')
        : waitingFor.isEmpty
            ? _t('等回复', 'waiting for a reply')
            : _t('等 ${waitingFor.join('、')}', 'waiting for ${waitingFor.join(', ')}');
    return '$subject · $state';
  }

  String moreRows(int count) => _t('还有 $count 个…', '$count more…');
  // Windows tray menu only
  String get changePort => _t('换一个端口', 'Use another port');
  String get launchAtLogin => _t('开机时启动', 'Launch at login');

  // What is running right now
  String reconnecting(String client) => _t('正在重新接入 $client…', 'Reconnecting $client…');
  String get reconnectingAgents => _t('正在重新接入 Agent…', 'Reconnecting Agents…');
  String get restrictingDataDir =>
      _t('正在修复数据文件夹，只留给你和系统…', 'Limiting the data folder to you and the system…');
  String get repairingOne => _t('正在修复…', 'Fixing…');
  String repairingMany(int count) => _t('正在修复 $count 件事…', 'Fixing ${_things(count)}…');
  String get starting => _t('正在启动 FULI…', 'Starting FULI…');
  // The steps a start really goes through (src/local-runtime/startup-stage.js),
  // shown under the loading mark while that step runs. An id this version does
  // not know keeps the plain "starting" sentence rather than showing the id.
  String? startupStage(String? stage) => switch (stage) {
        'checking' => _t('正在看 FULI 现在的状态…', 'Checking what FULI is doing now…'),
        'first_setup' => _t('第一次启动，正在安装 FULI…', 'First start: installing FULI…'),
        'start_wait' => _t('正在等另一次启动结束…', 'Waiting for another start to finish…'),
        'graph_runtime' => _t('正在准备图数据库…', 'Getting the graph database ready…'),
        'graph_install' => _t('正在安装图数据库程序…', 'Installing the graph database programs…'),
        'graph_start' => _t('正在启动图数据库…', 'Starting the graph database…'),
        'database_wait' => _t('正在等图数据库打开端口…', 'Waiting for the graph database to open its ports…'),
        'provider_wait' => _t('正在等 Provider 就绪…', 'Waiting for the Provider…'),
        'graph_setup' => _t('正在核对知识图谱的设置…', 'Checking the knowledge graph setup…'),
        'console_start' => _t('正在打开控制台…', 'Starting the console…'),
        'console_open' => _t('正在打开控制台窗口…', 'Opening the console window…'),
        _ => null,
      };

  /// The line under a step that has run longer than usual: how long it has
  /// waited, and the longest it will wait when the start reported that limit
  /// ([maxSeconds], taken from the wait's own constant). Nothing else: what it
  /// waits for is the step's own sentence above it.
  String startupStageSlow(Duration waited, int? maxSeconds) {
    final waiting = _t('已经等了${_spell(waited)}。', 'Waiting ${_spell(waited)} so far.');
    final limit = startupStageLimit(maxSeconds);
    return limit == null ? waiting : '$waiting${chinese ? '' : ' '}$limit';
  }

  /// The longest the step will wait, or null when its wait has no fixed limit.
  /// A screen reader hears this, not the waited time that changes every few seconds.
  String? startupStageLimit(int? maxSeconds) =>
      maxSeconds == null ? null : _t('最多等${_spell(Duration(seconds: maxSeconds))}。', 'It waits up to ${_spell(Duration(seconds: maxSeconds))}.');

  // "1 分 20 秒" / "1 min 20 s", from whole seconds only; hours and days alone.
  String _spell(Duration waited) {
    final seconds = waited.inSeconds;
    if (waited.inDays > 0) return _t(' ${waited.inDays} 天', '${waited.inDays} d');
    if (waited.inHours > 0) return _t(' ${waited.inHours} 小时', '${waited.inHours} h');
    if (seconds < 60) return _t(' $seconds 秒', '$seconds seconds');
    final minutes = seconds ~/ 60, rest = seconds % 60;
    if (rest == 0) return _t(' $minutes 分钟', '$minutes min');
    return _t(' $minutes 分 $rest 秒', '$minutes min $rest s');
  }
  String get stopping => _t('正在停止 FULI…', 'Stopping FULI…');
  String get restarting => _t('正在重启 FULI…', 'Restarting FULI…');
  String get changingPort => _t('正在换端口并重启 FULI…', 'Moving FULI to another port and restarting it…');
  String get checkingAfterUpdate => _t('正在检查更新后的 FULI…', 'Checking FULI after the update…');
  // The steps the core reports (src/system/console-update.js).
  String updateStep(String? step, String version) => switch (step) {
        'downloading' => _t('正在下载 v$version 的安装包…', 'Downloading the v$version package…'),
        'verifying' => _t('正在校验 v$version 的安装包…', 'Verifying the v$version package…'),
        'exitingTray' => _t('正在关闭 FULI 客户端，更新后会重新打开…', 'Closing the FULI client; it opens again after the update…'),
        'installing' => _t('正在安装 v$version，FULI 会停止并重新启动…', 'Installing v$version; FULI stops and starts again…'),
        _ => _t('正在更新到 v$version…', 'Updating to v$version…'),
      };

  // Outcomes
  String repaired(int count) => _t('已修复 $count 件事。', 'Fixed ${_things(count)}.');
  String repairFailed(int count, String reason) =>
      _t('$count 件没有修好：$reason', '${_things(count)} could not be fixed: $reason');
  String updated(String version) => _t('已更新到 v$version。', 'Updated to v$version.');
  String get updateUnchanged =>
      _t('没有需要安装的新版本，FULI 没有停止。', 'There was no newer version to install; FULI was not stopped.');
  String updateFailed(String reason) => _t('没有更新完成：$reason', 'The update did not finish: $reason');
  String get updateNotBack =>
      _t('FULI 还没有重新应答，稍后会再检查。', 'FULI has not answered again yet; it is checked again shortly.');
  String startFailed(String reason) => _t('没有启动成功：$reason', 'FULI did not start: $reason');
  // A start that failed for a reason it named (src/local-runtime/startup-failure.js):
  // what happened, then the next step as the button beside it; never a command
  // to type. Null for a code this version does not know.
  String? startFailedBecause(StartupFailure failure) {
    final since = _clock(failure.text('since'));
    final pid = failure.number('pid');
    final seconds = failure.number('seconds') ?? 60;
    return switch (failure.code) {
      // A switch journal waits for recovery: never a reason to release the lock.
      // What happened, what state the data is in, what not to do, and 恢复.
      'native_recovery_needed' => _recoveryNeeded(failure),
      'native_lifecycle_lock' => switch (failure.text('holder')) {
          'running' => _t('没有启动：数据库维护锁从 $since 起被进程 $pid${_named(failure)}占着。等它结束后再点「启动 FULI」。',
              'FULI did not start: process $pid${_named(failure)} has held the database maintenance lock since $since. Choose Start FULI once it has ended.'),
          'gone' => _interrupted(failure, since),
          _ => _t('没有启动：数据库维护锁从 $since 起一直没放开，没有记录是谁加的。',
              'FULI did not start: the database maintenance lock has been held since $since with no record of who took it.'),
        },
      'port_taken' => _portTaken(failure),
      'recovery_refused' => recoveryRefused(failure.text('reason'), failure.facts),
      'console_not_answering' => failure.number('stillRunningPid') != null
          ? _t('没有启动：控制台 $seconds 秒内没有应答，停它时也没停下来，进程 ${failure.number('stillRunningPid')} 可能还在。数据都在。',
              'FULI did not start: the console did not answer within $seconds s and did not end when stopped; process ${failure.number('stillRunningPid')} may still run. Your data is kept.')
          : _t('没有启动：控制台 $seconds 秒内没有应答。图数据库和 Provider 还在运行，数据都在。可以再点「启动 FULI」重试。',
              'FULI did not start: the console did not answer within $seconds s. The graph database and Provider still run and your data is kept. Choose Start FULI to retry.'),
      'console_exited' => _t('没有启动：控制台启动时退出了。图数据库和 Provider 还在运行，数据都在。可以再点「启动 FULI」重试。',
          'FULI did not start: the console exited while starting. The graph database and Provider still run and your data is kept. Choose Start FULI to retry.'),
      'console_port_reserved' => _t('没有启动：Windows 保留了控制台的端口 ${failure.number('port')}。在托盘菜单选「换一个端口」再试。',
          'FULI did not start: Windows reserves the console port ${failure.number('port')}. Choose Use another port in the tray menu and try again.'),
      'provider_not_ready' => _t('没有启动：Provider 启动后一直没有就绪。可以再点「启动 FULI」重试。',
          'FULI did not start: the Provider started but never became ready. Choose Start FULI to retry.'),
      'provider_exited' => _t('没有启动：Provider 在启动时退出了。可以再点「启动 FULI」重试。',
          'FULI did not start: the Provider exited while starting. Choose Start FULI to retry.'),
      _ => null,
    };
  }

  // A switch journal waits (src/native-runtime/neo4j-lifecycle-lock.js): what
  // the code can show of the data, never a reason to release the lock, and that
  // 「恢复并启动」 brings it back (src/native-runtime/neo4j-recovery.js).
  String _recoveryNeeded(StartupFailure failure) {
    const keep = '在那之前不要删除数据库维护锁，也不要用别的版本的 FULI 打开这份数据。';
    const keepEn = 'Until then, do not remove the maintenance lock or open this data with another FULI version.';
    if (failure.text('phase') == 'removing-assets') {
      return _t('没有启动：有一次数据库卸载没做完。卸载只删数据库程序文件，知识数据文件没有被改动。点「恢复并启动」把它做完。$keep',
          'FULI did not start: a database uninstall did not finish. An uninstall removes only the database programs; your knowledge data files were not changed. '
              'Choose Recover and start to finish it. $keepEn');
    }
    final from = failure.text('fromVersion'), to = failure.text('toVersion'), backup = failure.text('backupName');
    final versions = from != null && to != null ? _t('（$from → $to）', ' ($from → $to)') : '';
    final kept = failure.facts['upgrade'] == true && backup != null
        ? _t('升级前的图备份在 FULI 数据文件夹的 backups/graph/$backup。', ' The graph backup from before the upgrade is in backups/graph/$backup in the FULI data folder.')
        : '';
    return _t(
        '没有启动：有一次数据库${_operation(failure.text('operation'))}$versions没做完。FULI 没有复制或替换知识数据文件，但切换途中新版本的数据库可能已经打开过它们，被新版本打开过之后旧版本可能再也打不开。$kept'
            '点「恢复并启动」：先说明要做什么，你确认后才做。$keep',
        'FULI did not start: a database ${failure.text('operation') ?? 'switch'}$versions did not finish. FULI did not copy or replace your knowledge data files, '
            'but the newer database may already have opened them during the switch, and the older one may not open them again.$kept '
            'Choose Recover and start: it says what it will do first, and does it only once you confirm. $keepEn');
  }

  // A lock an operation left when it ended before any switch journal: what it
  // can have changed, and that 「恢复并启动」 deals with it.
  String _interrupted(StartupFailure failure, String since) {
    const none = '点「恢复并启动」：先说明要做什么，你确认后才做。';
    const noneEn = 'Choose Recover and start: it says what it will do first, and does it only once you confirm.';
    return switch (failure.text('operation')) {
      'load' => _t('没有启动：一次图数据库导入在 $since 中途停了，留下了维护锁。导入会覆盖数据库，所以数据库可能只写入了一半。$none',
          'FULI did not start: a graph database load stopped part way at $since and left its maintenance lock. A load overwrites the database, so it may be only half written. $noneEn'),
      'recover' => _t('没有启动：一次恢复在 $since 中途停了，留下了它加的维护锁。$none',
          'FULI did not start: a recovery stopped part way at $since and left the maintenance lock it took. $noneEn'),
      'dump' => _t('没有启动：一次图数据库导出在 $since 中途停了，留下了维护锁。导出只读数据库，知识数据没有被改动。$none',
          'FULI did not start: a graph database dump stopped part way at $since and left its maintenance lock. A dump only reads the database; your knowledge data was not changed. $noneEn'),
      final operation => _t(
          '没有启动：一次数据库${_operation(operation)}在 $since 中途停了，留下了维护锁。它停在改动知识数据之前，数据没有被改动，但可能留下了装了一半的程序文件。$none',
          'FULI did not start: a database ${operation ?? 'operation'} stopped part way at $since, before it changes any knowledge data, and left its maintenance lock; '
              'it may have left programs half installed. $noneEn'),
    };
  }

  // The operation a lock or journal names, in a Chinese sentence.
  String _operation(String? operation) =>
      const {'update': '更新', 'rollback': '回退', 'uninstall': '卸载', 'dump': '导出', 'load': '导入', 'recover': '恢复'}[operation] ?? '切换';

  // " (java)" / "（java）" when the holder's program is known.
  String _named(StartupFailure failure) {
    final command = failure.text('command');
    return command == null ? '' : _t('（$command）', ' ($command)');
  }

  String _portTaken(StartupFailure failure) {
    final port = failure.number('port'), pid = failure.number('pid'), command = failure.text('command');
    final running = failure.number('runningSeconds');
    final who = ['进程 $pid', ?command].join(' · ');
    final whoEn = ['process $pid', ?command].join(' · ');
    return _t(
        '没有启动：端口 $port 被另一个程序占着（$who${running == null ? '' : '，已运行${_spell(Duration(seconds: running))}'}），FULI 没有动它。如果它是之前没停干净的 FULI 图数据库，结束它后再点「启动 FULI」。',
        'FULI did not start: another program holds port $port ($whoEn${running == null ? '' : ', running for ${_spell(Duration(seconds: running))}'}); FULI left it alone. If it is a FULI graph database that did not stop cleanly, end it, then choose Start FULI.');
  }

  // A lock a person may release: only one with no recorded holder. A start's
  // or stop's lock whose holder ended is taken over by the start itself, and an
  // update's, rollback's or uninstall's may have left files half installed
  // (src/native-runtime/neo4j-lifecycle-lock.js). A recovery that found such a
  // lock without a switch journal points here too.
  bool releasableLock(StartupFailure failure) =>
      (failure.code == 'native_lifecycle_lock' && failure.text('holder') == 'unknown') ||
      (failure.code == 'recovery_refused' && failure.text('reason') == 'no_holder');

  // What `fuli graph runtime recover` deals with: a switch journal, or a lock an
  // update, rollback, uninstall, dump or load left (src/native-runtime/neo4j-recovery.js);
  // and a recovery that stopped for a reason that can pass, so trying again is the way on.
  bool recoverable(StartupFailure failure) =>
      failure.code == 'native_recovery_needed' ||
      (failure.code == 'native_lifecycle_lock' && failure.text('holder') == 'gone') ||
      (failure.code == 'recovery_refused' && _retryable.contains(failure.text('reason'))) ||
      keepableSwitch(failure);

  // An interrupted import whose own copy cannot be used: 「放弃这次导入…」 is the
  // way on, and it is the person's own choice (its graphs end up empty).
  bool abandonableImport(StartupFailure failure) =>
      failure.code == 'recovery_refused' && const {'restore_point_unknown', 'restore_point_damaged'}.contains(failure.text('reason'));

  // A switch whose newer version neither finished nor went back to a start:
  // 「保留新版本并解除这把锁…」 is offered beside trying again.
  bool keepableSwitch(StartupFailure failure) =>
      failure.code == 'recovery_refused' &&
      const {'start_failed', 'format_changed'}.contains(failure.text('reason')) &&
      const {'finish_switch', 'back_out_switch', 'continue_back_out'}.contains(failure.text('planKind'));

  static const _retryable = {
    'holder_running', 'fuli_running', 'cannot_inspect', 'too_recent', 'cannot_stop_services', 'unknown_assets',
    'format_unreadable', 'start_failed', 'restore_failed', 'lock_changed', 'step_failed', 'plan_changed',
    // Asked to abandon an import there is no reason (or no import) to abandon: the ordinary recovery is the way.
    'restore_point_usable', 'no_import', 'recovery_running', 'keep_newer_unavailable',
  };

  // Fits the status bar's primary place (status_actions.dart `_primaryWidth`).
  String get recoverAndStart => _t('恢复并启动', 'Recover and start');
  String get recoveryTitle => _t('恢复这次没做完的数据库操作？', 'Recover the unfinished database operation?');
  String get recoveryConfirm => _t('恢复并启动', 'Recover and start');
  // The two ways out of a switch whose newer version already took effect.
  String keepVersion(String? version) => _t(version == null ? '保留新版本并启动' : '保留 $version 并启动', 'Keep ${version ?? 'the newer version'} and start');
  String backOutTo(String? version) => _t(version == null ? '撤回到旧版本并启动' : '撤回到 $version 并启动', 'Go back to ${version ?? 'the older version'} and start');
  // Giving up an import empties graphs: its own button and words, never 「恢复并启动」.
  String get abandonImport => _t('放弃这次导入…', 'Abandon the import…');
  String get abandonImportTitle => _t('放弃这次没做完的导入？', 'Abandon the unfinished import?');
  String get abandonImportConfirm => _t('放弃导入，清空这些图谱', 'Abandon and empty these graphs');
  // Keeping the newer version of a switch that neither finishing nor backing out got to start: its own button and words.
  String get keepNewer => _t('保留新版本并解除这把锁…', 'Keep the newer version and unlock…');
  String get keepNewerTitle => _t('保留新版本并解除这把锁？', 'Keep the newer version and release the lock?');
  String get keepNewerConfirm => _t('保留新版本并解锁', 'Keep it and unlock');
  // After a recovery that left graph data in the recovered folder.
  String get keptGraphDataTitle => _t('挪开的图谱数据还在', 'The graph data that was moved aside is kept');
  // A window running the `fuli` CLI: the CLI acts only at a terminal, so the plan comes with the command to run there.
  String get recoveryInTerminalTitle => _t('在终端里完成', 'Finish this in Terminal');
  String get recoveryInTerminal =>
      _t('这个窗口用的是终端里装的 fuli，它只在你自己敲命令的终端里做这一步。打开「终端」，运行下面的命令；它会再说明一遍要做什么，你确认后才做。',
          'This window uses the fuli installed for your terminal, which does this only in a terminal you type in. Open Terminal and run the command below; it says again what it will do and acts only once you confirm.');
  String get copyCommand => _t('复制命令', 'Copy command');

  /// The plan in the person's words: what it is, what to know before
  /// confirming, then each step; or why it will not.
  List<String> recoveryPlanWords(RecoveryPlan plan) {
    if (plan.kind == 'nothing') return [_t('没有要恢复的东西，点「启动 FULI」即可。', 'There is nothing to recover; choose Start FULI.')];
    if (plan.kind == 'refused') return [recoveryRefused(plan.text('reason'), plan.facts)];
    final from = plan.text('fromVersion'), to = plan.text('toVersion');
    final what = switch (plan.kind) {
      'undo_switch' => _t('新版本还没有生效：回到切换前的状态。', 'The newer version never took effect: go back to before the switch.'),
      'finish_switch' => _t('新版本${to ?? ''}已经生效：先确认它能启动、存储格式没变，再保留它，把这次切换做完。',
          'The newer version${to == null ? '' : ' $to'} already took effect: once it starts and the store format is unchanged, keep it and finish the switch.'),
      'back_out_switch' => _t('回到切换前的版本${from ?? ''}：先确认存储格式没变、旧版本能启动；旧版本起不来就保持新版本。',
          'Go back to the version before the switch${from == null ? '' : ', $from'}: once the store format is unchanged and it starts; if it does not, the newer version stays.'),
      'finish_uninstall' => _t('把没做完的卸载做完：剩下的数据库程序移到 recovered 文件夹，知识数据不动。',
          'Finish the uninstall: the remaining database programs move to the recovered folder; knowledge data is not touched.'),
      'clear_interrupted' => _t('操作停在改动数据之前：把装了一半的东西放到一边，再解除锁。', 'It stopped before changing any data: set aside what it half installed, then release the lock.'),
      'release_dump' => _t('导出只读数据库：直接解除它留下的锁。', 'A dump only reads the database: release the lock it left.'),
      'restore_load' => _t('把中途停下的导入撤回到导入前：导入可能只写了一半。这次想导入的内容不会保留，之后需要重新导入。',
          'Take the interrupted import back to before it: it may be half written. What it was importing is not kept; import it again afterwards.'),
      'continue_back_out' => _t('接着做中途停下的撤回：描述文件已经写回${from ?? '旧版本'}，但${to ?? '新版本'}之前已经打开过这个库；先确认${from ?? '旧版本'}还能启动，不行就写回${to ?? '新版本'}。',
          'Continue the back-out that stopped part way: the descriptor is ${from ?? 'the older version'}\'s again, but ${to ?? 'the newer version'} had already opened the store; ${from ?? 'the older version'} must start on it, otherwise ${to ?? 'the newer version'} is written back.'),
      'finish_recovery' => _t('上一次恢复的步骤都做完了，只剩解除它加的锁。', 'The last recovery\'s steps are done; only the lock it took is left.'),
      'abandon_load' => _t('放弃这次中途停下的导入：导入前留下的副本用不了，没法撤回到导入前。只把这次导入写过的库挪开，没写过的原地不动。',
          'Abandon the interrupted import: the copy taken before it cannot be used, so the graph cannot go back to before the import. Only the databases this import wrote move aside; the others stay as they are.'),
      'keep_newer' => _t('保留新版本${to ?? ''}并解除这把锁：不再做启动检查，切换记录移到 recovered 文件夹，解除数据库维护锁。之后起不来就是一次普通的启动失败，会说明原因和下一步。',
          'Keep the newer version${to == null ? '' : ' $to'} and release the lock: no start check; the switch journal moves to the recovered folder and the maintenance lock is released. If it does not start afterwards, that is an ordinary failed start, which says why and what to do next.'),
      _ => plan.kind,
    };
    return [what, ..._recoveryFacts(plan), for (final step in plan.steps) '· ${_recoveryStep(step)}'];
  }

  // What the person should know before confirming, beyond the steps.
  List<String> _recoveryFacts(RecoveryPlan plan) {
    final backup = plan.text('backupPath');
    final copy = plan.facts['restorePoint'];
    final emptied = plan.facts['emptied'];
    return [
      if (backup != null && (plan.kind == 'finish_switch' || plan.kind == 'back_out_switch'))
        _t('升级前的图备份在 $backup。', 'The graph backup from before the upgrade is at $backup.'),
      if (plan.kind == 'keep_newer') ...[
        _t('解锁之后可以重新更新一次，或用升级前的备份整库导回。', 'Afterwards you can update again, or import the backup from before the upgrade whole.'),
        if (backup != null) ...[
          _t('升级前的图备份在 $backup，在终端里这样导回：', 'The graph backup from before the upgrade is at $backup; import it in Terminal with:'),
          'fuli graph import --input "$backup" --yes',
        ],
      ],
      if (plan.kind == 'restore_load' && plan.facts['restored'] == true)
        _t('图已经从导入前的副本导回，这次不再导一遍。', 'The graph is already back from the copy taken before the import; it is not imported again.'),
      if (plan.kind == 'restore_load' && copy is Map)
        _t('用这次导入开始前（${_clock('${copy['createdAt']}')}）自动留下的备份恢复 ${_names(copy['instances'])}。',
            '${_names(copy['instances'])} ${_count(copy['instances']) == 1 ? 'goes' : 'go'} back to the copy this import took before it started (${_clock('${copy['createdAt']}')}).'),
      if (plan.kind == 'restore_load' && emptied is List && emptied.isNotEmpty)
        _t('${_names(emptied)} 在导入前是空的，恢复后也是空的。',
            '${_names(emptied)} ${emptied.length == 1 ? 'was' : 'were'} empty before the import and will be empty again.'),
      if (plan.kind == 'abandon_load') ..._abandonFacts(plan),
    ];
  }

  // Why the import's copy cannot be used, which graphs it wrote (they end up
  // empty), which it may have written (moved too, said as such), which stay,
  // how to move a store back, and which copies an import can bring back.
  List<String> _abandonFacts(RecoveryPlan plan) {
    final backup = plan.text('backupPath') ?? '';
    final dataDir = plan.text('dataDir') ?? '';
    final folder = plan.text('folder') ?? _t('$dataDir/native-runtime/recovered/<时间>', '$dataDir/native-runtime/recovered/<time>');
    final copies = plan.facts['copies'];
    final moveBack = plan.facts['moveBack'];
    List<Object?> ids(String key) => plan.facts[key] is List ? plan.facts[key] as List : const [];
    return [
      switch (plan.text('copyProblem')) {
        'missing' => _t('这次导入在导入前留的副本找不到了：$backup。', 'The copy this import took before it started is gone: $backup.'),
        'damaged' => _t('这次导入在导入前留的副本已损坏（读不出或校验和不对）：$backup。', 'The copy this import took before it started is damaged (unreadable, or its checksums do not match): $backup.'),
        _ => _t('这次导入没有记下它在导入前留的是哪一份副本，或记下的认不出。', 'This import did not record which copy it took before it started, or recorded one FULI cannot recognise.'),
      },
      if (plan.facts['allInstances'] == true)
        _t('这把锁是旧版本 FULI 留下的，没有记下导入的是哪些图谱，所以每个图谱都按文件的修改时间判断。',
            'An older FULI took this lock and did not record which graphs it was importing, so every graph is judged by when its files last changed.'),
      if (ids('written').isNotEmpty)
        _t('${_names(ids('written'))}：导入开始后它的库被写过，可能只写了一半。继续的话会变成空的，写过的库移到 $folder，不删除。',
            '${_names(ids('written'))}: its database was written after the import began and may be half written. If you go on, it will be empty; the database moves to $folder, not deleted.'),
      if (ids('unsure').isNotEmpty)
        _t('${_names(ids('unsure'))}：判断不了它有没有被这次导入写过，所以一起挪开；它的库是完好的可能性很大。继续的话会变成空的，库移到 $folder，不删除。',
            '${_names(ids('unsure'))}: whether this import wrote it cannot be told, so it moves aside too; its database is quite likely intact. If you go on, it will be empty; the database moves to $folder, not deleted.'),
      if (ids('untouched').isNotEmpty)
        _t('${_names(ids('untouched'))}：导入开始后没有被写过，原地不动。', '${_names(ids('untouched'))}: not written since the import began; it stays as it is.'),
      if (moveBack is List && moveBack.isNotEmpty) ...[
        _t('想把挪走的库搬回原位：先退出 FULI，原位置已经有 FULI 新建的空库时先把它改名挪开，再在终端里运行：',
            'To move a database back where it was: quit FULI first; if FULI already made a new empty database there, rename it out of the way; then run in Terminal:'),
        for (final move in moveBack)
          if (move is Map) 'mv "${move['from']}" "${move['to']}"',
      ],
      if (copies is List && copies.isNotEmpty) ...[
        _t('之后也可以在终端里从一份导入前的副本整库导回（会覆盖当时的图谱）：', 'Afterwards, a whole copy from before an earlier import can also be brought back in Terminal (it replaces the graph then):'),
        for (final copy in copies)
          if (copy is Map)
            '${_clock(copy['createdAt'] as String?)} · ${copy['bytes'] is int ? _size(copy['bytes'] as int) : '?'} · ${_names(copy['instances'])}\n'
                'fuli graph import --input "${copy['path']}" --data-dir "$dataDir" --yes',
      ] else
        _t('$dataDir/backups/graph 里没有可以导回的导入前副本；有自己的导出时，在终端里用 fuli graph import --input <导出目录> 导回。',
            '$dataDir/backups/graph holds no copy from before an import to bring back; with an export of your own, bring it back in Terminal with fuli graph import --input <export folder>.'),
    ];
  }

  /// The recovered folders that hold graph data a recovery moved aside: where,
  /// how big, which graphs, and how to move each store back. The clean-up never
  /// deletes them (src/native-runtime/recovered-dir.js).
  List<String> keptGraphDataWords(List<Map<String, Object?>> folders) => [
        _t('recovered 文件夹里有挪开的图谱数据，自动清理不会删它们；确认不需要后由你自己删除。',
            'The recovered folder holds graph data that was moved aside; the clean-up never deletes it, so delete it yourself once you are sure it is not needed.'),
        for (final folder in folders)
          '${folder['path']} · ${folder['bytes'] is int ? _size(folder['bytes'] as int) : '?'} · ${_names(folder['instances'])}',
        _t('要搬回原位：先退出 FULI，原位置已经有新建的空库时先把它改名挪开，再在终端里运行：',
            'To move one back: quit FULI first; if a new empty database is already there, rename it out of the way; then run in Terminal:'),
        for (final folder in folders)
          if (folder['stores'] is List)
            for (final store in folder['stores'] as List)
              if (store is Map) 'mv "${store['from']}" "${store['to']}"',
      ];

  int _count(Object? ids) => ids is List ? ids.length : 0;

  String _names(Object? ids) => [
        if (ids is List)
          for (final id in ids) id == 'personal' ? _t('个人图谱', 'the personal graph') : id == 'workspace' ? _t('工作区图谱', 'the workspace graph') : '$id'
      ].join(_t('、', ', '));

  /// When the plan offers the other way out of a switch: what it is, or why it is not offered.
  String? recoveryAlternativeWords(RecoveryPlan plan) {
    final from = plan.text('fromVersion'), to = plan.text('toVersion');
    final alternative = plan.alternative;
    if (alternative?.kind == 'back_out_switch') {
      return _t('也可以撤回到切换前的 ${from ?? '旧版本'}：它先确认存储格式没变、旧版本能启动，起不来就保持现在的 ${to ?? '新版本'}。',
          'You can also go back to ${from ?? 'the older version'}: it first checks the store format is unchanged and the older version starts; if it does not, ${to ?? 'the newer version'} stays.');
    }
    final refused = plan.text('alternativeRefused');
    if (refused == null) return null;
    return _t('不能撤回到 ${from ?? '旧版本'}：${_backOutBlocked(refused)}', 'Going back to ${from ?? 'the older version'} is not offered: ${_backOutBlocked(refused)}');
  }

  String _backOutBlocked(String reason) => switch (reason) {
        'no_fingerprint' => _t('切换记录里没有旧版本程序的指纹，没法确认旧版本完好。', 'the switch journal has no fingerprint of the older programs, so they cannot be checked.'),
        'assets_changed' => _t('旧版本的数据库程序变过。', 'the older database programs changed.'),
        'format_changed' => _t('存储格式已经和切换前不一样。', 'the store format is no longer the one from before the switch.'),
        'unmanaged_path' => _t('旧版本的程序不在 FULI 管理的位置。', 'the older programs are outside the places FULI manages.'),
        _ => reason,
      };

  String _recoveryStep(Map<String, Object?> step) {
    final path = '${step['path'] ?? ''}';
    final bytes = step['bytes'];
    final size = bytes is int ? _t('，${_size(bytes)}', ', ${_size(bytes)}') : '';
    String last(Object? value) => '$value'.split(RegExp(r'[\\/]')).last;
    return switch (step['do']) {
      'stop-services' => _t('停止 FULI 记录的图数据库和 Provider', 'Stop the graph database and Provider FULI recorded'),
      'check-start' => step['revert'] != null
          ? _t('用 ${step['version']} 启动一次，确认能应答，再停下；起不来就写回新版本', 'Start ${step['version']} once, check it answers and stop it; if it does not, the newer version is written back')
          : step['afterRestore'] == true
              ? _t('用 ${step['version'] ?? '数据库'} 启动一次，确认能应答，再停下；图已经导回，起不来也照样解除锁，并说明起不来的原因',
                  'Start ${step['version'] ?? 'the database'} once, check it answers and stop it; the graph is already back, so the lock is released even if it does not start, and why is said')
              : _t('用 ${step['version'] ?? '数据库'} 启动一次，确认能应答，再停下', 'Start ${step['version'] ?? 'the database'} once, check it answers and stop it'),
      'mark-restored' => _t('在锁里记下「已导回」，之后重跑不会再导一遍', 'Record in the lock that the graph is back, so running again does not import it again'),
      'mark-backing-out' => _t('在切换记录里记下「正在撤回」', 'Record in the switch journal that it is being backed out'),
      'check-formats' => _t('确认存储格式和切换前一样', 'Check the store format is the one from before the switch'),
      'check-fingerprint' => _t('确认旧版本的数据库程序没有变', 'Check the older database programs did not change'),
      'write-manifest' => _t('写回数据库描述文件（原来的先复制到 recovered 文件夹）', 'Write the database descriptor (the one there is first copied to the recovered folder)'),
      'move-aside' => _t('把${_movedWhat(path)[0]}（${last(path)}$size）移到 recovered 文件夹，不删除',
          'Move ${_movedWhat(path)[1]} (${last(path)}$size) to the recovered folder, not deleted'),
      'rename' => _t('把没写完的备份改名为 ${last(step['to'])}', 'Rename the unfinished backup to ${last(step['to'])}'),
      'archive-journal' => _t('把切换记录移到 recovered 文件夹', 'Move the switch journal to the recovered folder'),
      'restore' => _t('从导入前的备份整库恢复 ${_names(step['instances'])}', 'Restore ${_names(step['instances'])} whole from the copy taken before the import'),
      'prune' => _t('解除锁之后永久删除一个旧的恢复文件夹（${last(path)}$size：只有数据库程序和记录，没有图谱数据；超过 ${step['keepDays']} 天，之后又有至少 ${step['keepRuns']} 次恢复；删不掉不影响恢复）',
          'After the lock is released, permanently delete an old recovery folder (${last(path)}$size: only database programs and records, no graph data; over ${step['keepDays']} days old, with at least ${step['keepRuns']} newer recoveries; if it cannot be deleted, the recovery still counts)'),
      'release-lock' => _t('解除数据库维护锁', 'Release the database maintenance lock'),
      _ => '${step['do']}',
    };
  }

  // What a moved directory is, in words.
  List<String> _movedWhat(String path) {
    if (RegExp(r'[\\/]data[\\/]databases[\\/]neo4j$').hasMatch(path)) return ['一个图谱的数据库', 'a graph database'];
    if (RegExp(r'[\\/]transactions[\\/]neo4j$').hasMatch(path)) return ['它的事务日志', 'its transaction logs'];
    if (RegExp(r'[\\/]jvs-a-[^\\/]+$').hasMatch(path)) return ['一份数据库程序', 'a copy of the database programs'];
    return ['数据库程序', 'the database programs'];
  }

  // "340 MB", "1.2 GB" (src/text/byte-size.js says the same in the terminal).
  String _size(int bytes) {
    const units = ['KB', 'MB', 'GB', 'TB'];
    var value = bytes / 1024;
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return '${value >= 10 || value == 0 ? value.round() : value.toStringAsFixed(1)} ${units[unit]}';
  }

  // Why a recovery will not run, and the next step in this window
  // (src/cli/recovery-plan-text.js says the same in the terminal).
  String recoveryRefused(String? reason, Map<String, Object?> facts) {
    final pid = facts['pid'];
    final retry = _t('再点「恢复并启动」。', 'then choose Recover and start again.');
    final root = facts['runtimeDir'] is String ? facts['runtimeDir'] as String : 'native-runtime';
    final backup = facts['backupPath'] is String ? facts['backupPath'] as String : null;
    // What FULI no longer decides by itself: the way out by hand, with the paths filled in.
    final look = _t(
        '数据库维护锁和记录都留着，FULI 不再往下做。要自己解开：先退出 FULI，在访达里把 $root 里的 neo4j-transaction.json（如果有）和 .neo4j-lifecycle.lock 移到 $root/recovered 里（不要删除），再启动 FULI；图谱打不开时用备份整库导回${backup == null ? '' : '（升级前的备份是 $backup）'}。也可以在托盘菜单选「导出诊断包…」，交给帮你看的人。',
        'The maintenance lock and the records stay and FULI goes no further. To get out by hand: quit FULI, move neo4j-transaction.json (if there) and .neo4j-lifecycle.lock in $root into $root/recovered in Finder (do not delete them), then start FULI; if the graph does not open, import a backup whole${backup == null ? '' : ' (the backup from before the upgrade is $backup)'}. Export diagnostics… in the tray menu also helps whoever looks.');
    final planKind = facts['planKind'];
    final switching = const {'finish_switch', 'back_out_switch', 'continue_back_out'}.contains(planKind);
    final backingOut = planKind == 'back_out_switch' || planKind == 'continue_back_out';
    final from = facts['fromVersion'] is String ? facts['fromVersion'] as String : null;
    final to = facts['toVersion'] is String ? facts['toVersion'] as String : null;
    // The other way out of the same switch, only when it is there.
    final other = facts['alternative'] == 'back_out_switch'
        ? _t('可以点「恢复并启动」选撤回到 ${from ?? '旧版本'}。', 'You can choose Recover and start and go back to ${from ?? 'the older version'}.')
        : backingOut || facts['alternative'] == 'finish_switch'
            ? _t('可以点「恢复并启动」完成切换、保留 ${to ?? '新版本'}。', 'You can choose Recover and start and keep ${to ?? 'the newer version'}.')
            : '';
    final keep = _t('如果新版本就是起不来、也回不去，可以在「恢复并启动」里点「保留新版本并解除这把锁…」，解锁后可以重新更新一次，或用升级前的备份导回。',
        'If the newer version will not start and going back does not work, choose Keep the newer version and unlock… under Recover and start; afterwards you can update again, or import the backup from before the upgrade.');
    final startFailure = facts['startFailure'] is Map ? facts['startFailure'] as Map : null;
    final why = startFailure == null ? '' : _startFailureWords(startFailure);
    final record = facts['record'] is String ? _t('做了的步骤记在 ${facts['record']}。', ' The steps done are recorded in ${facts['record']}.') : '';
    return switch (reason) {
      'holder_running' => _t('没有恢复：进程 $pid 还在用数据库维护锁。等它结束后$retry', 'Not recovered: process $pid still holds the maintenance lock. Wait for it to end, $retry'),
      'fuli_running' => _t('没有恢复：另一个 FULI 命令（进程 $pid）正在用这份数据。等它结束后$retry', 'Not recovered: another FULI command (process $pid) is using this data. Wait for it to end, $retry'),
      'cannot_inspect' => _t('没有恢复：看不到正在运行的程序，没法确认没人在用。稍后$retry', 'Not recovered: the running programs could not be listed, so nobody using it could be ruled out. Wait a moment, $retry'),
      'no_holder' => _t('没有恢复：这把锁没有记录是谁加的，不归恢复管。点「解除这把锁并启动」，它会先做同样的检查。',
          'Not recovered: this lock records no holder, which is not for a recovery. Choose Unlock and start; it makes the same checks first.'),
      'too_recent' => _t('没有恢复：这把锁没有记录是谁加的，加上还不到 90 分钟，可能还有人在用。${_clock(facts['releasableAt'] as String?)} 之后$retry',
          'Not recovered: this lock records no holder and is less than 90 minutes old, so it may still be in use. After ${_clock(facts['releasableAt'] as String?)}, $retry'),
      'cannot_stop_services' => _t('没有恢复：图数据库（进程 $pid）还在运行，又没有锁能停它。在「活动监视器」里结束进程 $pid，$retry',
          'Not recovered: a graph database (process $pid) still runs and there is no lock to stop it with. End process $pid in Activity Monitor, $retry'),
      'manifest_changed' => _t('没有恢复：数据库描述文件既不是操作前也不是操作后的样子，可能有人改过或重装过。$look',
          'Not recovered: the database descriptor is neither the one from before nor after the operation; it may have been changed or reinstalled. $look'),
      'unknown_journal' => _t('没有恢复：切换记录是空的、坏了或看不懂。$look', 'Not recovered: the switch journal is empty, damaged or unreadable. $look'),
      'unmanaged_path' => _t('没有恢复：记录里的数据库程序不在 FULI 管理的位置，FULI 不动它。$look',
          'Not recovered: the records name database programs outside the places FULI manages, so FULI leaves them alone. $look'),
      'assets_changed' => _t('没有恢复：数据库程序在操作中途被改过。$look', 'Not recovered: the database programs changed during the operation. $look'),
      'unknown_assets' => _t('没有恢复：数据库程序文件夹里有一个认不出的目录（${facts['directory']}）：名字像 FULI 的，但里面没有 FULI 的记录，FULI 没有动它。确认不需要后，在访达里把它移出 neo4j-assets（不要删除），$retry',
          'Not recovered: the database programs folder holds a directory FULI cannot recognise (${facts['directory']}): its name looks like FULI\'s but it carries no FULI record, so FULI left it alone. Once you are sure it is not needed, move it out of neo4j-assets in Finder (do not delete it), $retry'),
      'no_fingerprint' => _t('没有恢复：没法确认旧版本的程序完好，所以不能撤回；可以保留新版本。', 'Not recovered: the older programs cannot be checked, so going back is not possible; the newer version can be kept.'),
      'format_changed' => switching
          ? _t('没有恢复：存储格式和切换前记下的不一样，所以没有往下做，描述文件保持原样，锁和切换记录留着。$other$keep$record',
              'Not recovered: the store format is not the one recorded before the switch, so it went no further; the descriptor was left as it was, and the lock and journal stay. $other $keep$record')
          : _t('没有恢复：存储格式和切换前记下的不一样，继续不安全。$look', 'Not recovered: the store format is not the one recorded before the switch, so going on is unsafe. $look'),
      'format_unreadable' => _t('没有恢复：读不出存储格式。稍后$retry', 'Not recovered: the store format could not be read. Wait a moment, $retry'),
      'start_failed' => backingOut
          ? _t('没有恢复：旧版本${from ?? ''}没能启动或没有应答，描述文件已经写回新版本，锁和切换记录都留着。$why$other原因解决后$retry$keep$record',
              'Not recovered: the older version${from == null ? '' : ' $from'} did not start or did not answer; the newer descriptor was written back, and the lock and journal stay. $why$other Once the cause is fixed, $retry $keep$record')
          : _t('没有恢复：新版本${to ?? ''}没能启动或没有应答，描述文件保持原样，锁和切换记录都留着。$why$other原因解决后$retry$keep$record',
              'Not recovered: the newer version${to == null ? '' : ' $to'} did not start or did not answer; the descriptor was left as it was, and the lock and journal stay. $why$other Once the cause is fixed, $retry $keep$record'),
      'restore_failed' => _t('没有恢复：没能从导入前的备份恢复${facts['detail'] is String ? '（${facts['detail']}）' : ''}，锁留着，所以不会在写了一半的图上启动。原因解决后（例如腾出磁盘空间）$retry还不行就在托盘菜单选「导出诊断包…」，交给帮你看的人。$record',
          'Not recovered: restoring from the copy taken before the import did not finish${facts['detail'] is String ? ' (${facts['detail']})' : ''}; the lock stays, so nothing starts on a half-written graph. Once the cause is fixed (free disk space, say), $retry If it fails again, Export diagnostics… in the tray menu helps whoever looks.$record'),
      'restore_point_unknown' => _t('没有恢复：这次导入没有记下它在导入前留的是哪一份副本，FULI 不猜。可以点「放弃这次导入…」：先说明会怎样，你确认后才做。',
          'Not recovered: this import did not record which copy it took before it started, and FULI does not guess. You can choose Abandon the import…: it says what that means first, and acts only once you confirm.'),
      'restore_point_damaged' => _t('没有恢复：这次导入在导入前留下的副本${facts['why'] == 'missing' ? '找不到了' : '已损坏'}，FULI 不改用别的副本。可以点「放弃这次导入…」：先说明会怎样，你确认后才做。$record',
          'Not recovered: the copy this import took before it started is ${facts['why'] == 'missing' ? 'gone' : 'damaged'}, and FULI does not use another one instead. You can choose Abandon the import…: it says what that means first, and acts only once you confirm.$record'),
      'restore_point_usable' => _t('没有放弃：这次导入在导入前留下的副本还能用，点「恢复并启动」把图撤回到导入前。',
          'Not abandoned: the copy this import took before it started can still be used; choose Recover and start to take the graph back to before the import.'),
      'no_import' => _t('没有放弃：现在没有中途停下的导入。', 'Not abandoned: there is no interrupted import now.'),
      'lock_changed' => _t('没有恢复：锁在恢复途中变了。$retry', 'Not recovered: the lock changed during the recovery; $retry'),
      'recovery_running' => _t('没有恢复：另一个恢复（进程 $pid）正在进行，这次什么都没做。等它结束后$retry',
          'Not recovered: another recovery (process $pid) is in progress, so nothing was done. Wait for it to end, $retry'),
      'keep_newer_unavailable' => _t('没有解锁：现在没有新版本已经生效、还没做完的切换，不需要保留新版本。点「恢复并启动」看要做什么。',
          'Not unlocked: there is no unfinished switch whose newer version took effect, so there is nothing to keep. Choose Recover and start to see what is needed.'),
      'step_failed' => _t('没有恢复：在“${facts['step']}”这一步停下了，锁留着。$retry会接着做。$record',
          'Not recovered: it stopped at the step "${facts['step']}" and the lock stays. Choose Recover and start again to continue.$record'),
      'plan_changed' => _t('没有恢复：情况在你确认之后变了，什么都没做。$retry看新的计划。', 'Not recovered: things changed after you confirmed, so nothing was done; $retry'),
      _ => _t('没有恢复：$reason。$look', 'Not recovered: $reason. $look'),
    };
  }

  // Why a start check failed (neo4j-recovery.js startFailureOf): who holds the port, the message, where the logs are.
  String _startFailureWords(Map<Object?, Object?> failure) {
    final start = failure['failure'];
    final port = start is Map && start['code'] == 'port_taken'
        ? _t('端口 ${start['port']} 被${start['pid'] != null ? '进程 ${start['pid']} ' : '别的程序'}占着。', 'Port ${start['port']} is in use${start['pid'] != null ? ' by process ${start['pid']}' : ''}. ')
        : '';
    final logs = failure['logs'] is List ? (failure['logs'] as List).join(_t('、', ', ')) : null;
    return '$port${failure['message'] ?? ''}${_t('。', '. ')}${logs == null ? '' : _t('日志在 $logs。', 'Logs are in $logs. ')}';
  }

  /// After a recovery: where what it did is recorded.
  String recovered(String record) => _t('已恢复。做了什么记在 $record。', 'Recovered. What it did is recorded in $record.');

  String get releaseLockAndStart => _t('解除这把锁并启动', 'Unlock and start');
  String get releaseLockTitle => _t('解除数据库维护锁？', 'Release the database maintenance lock?');
  String get releaseLockBody => _t(
      'FULI 会先核对：没有没做完的数据库切换，记录里的图服务都已停止，没有别的 FULI 命令在用这份数据，锁也已经放了足够久。任何一项不满足都不会解除，并告诉你是哪一项。',
      'FULI checks first: no database switch is unfinished, the graph services it recorded have stopped, no other FULI command is using this data, '
          'and the lock is old enough. If any check fails, the lock stays and FULI says which one.');
  String get releaseLockConfirm => _t('核对后解除并启动', 'Check, release and start');

  // Why a confirmed release kept the lock (lockReleaseRefusal in src/local-runtime/startup-failure.js).
  String lockKept(StartupFailure kept) {
    final pid = kept.number('pid');
    return switch (kept.code) {
      'recovery_needed' => _t('锁没有解除：有一次数据库切换没做完，需要先恢复。', 'The lock was kept: a database switch did not finish and needs recovery first.'),
      'holder_running' => _t('锁没有解除：进程 $pid 还在用它。', 'The lock was kept: process $pid still holds it.'),
      'services_running' => _t('锁没有解除：FULI 记录的图服务（进程 $pid）还在运行。', 'The lock was kept: a graph service FULI recorded (process $pid) still runs.'),
      'fuli_running' => _t('锁没有解除：另一个 FULI 命令（进程 $pid）正在用这份数据。', 'The lock was kept: another FULI command (process $pid) is using this data.'),
      'cannot_inspect' => _t('锁没有解除：看不到正在运行的程序，没法确认没人在用。', 'The lock was kept: the running programs could not be listed, so nobody using it could be ruled out.'),
      'too_recent' => _t('锁没有解除：它加上不久，一次数据库更新可能还在进行。${_clock(kept.text('releasableAt'))} 之后再试。',
          'The lock was kept: it is recent and a database update may still be running. Try again after ${_clock(kept.text('releasableAt'))}.'),
      'no_lock' => _t('锁已经不在了，点「启动 FULI」即可。', 'The lock is already gone; choose Start FULI.'),
      'asset_operation' => _t('锁没有解除：它是一次数据库${_operation(kept.text('operation'))}留下的，这个按钮不解除它。',
          'The lock was kept: a database ${kept.text('operation') ?? 'operation'} left it, and this button does not release that.'),
      'unfinished_assets' => _t('锁没有解除：有没装完的数据库程序，可能是一次被打断的更新留下的。',
          'The lock was kept: unfinished database programs remain, possibly from an interrupted update.'),
      'changed' => _t('锁没有解除：它在核对时被换掉了。', 'The lock was kept: it changed while it was being checked.'),
      _ => _t('锁没有解除。', 'The lock was kept.'),
    };
  }

  // Client sessions stopped starting FULI after repeated starts did not keep it up.
  String autostartGaveUp(String at) => _t('自动重启已经停了：$at 起 FULI 自己启动了几次都没能保持运行，不会再自己起来。点「启动 FULI」再试。',
      'Automatic restarts have stopped: since $at FULI started itself several times without staying up, and will not start by itself again. Choose Start FULI to try again.');
  String get viewStartupLog => _t('查看启动日志', 'View the startup log');

  // "11-23 01:24" in this computer's time, from an ISO time; the text itself when it is none.
  String _clock(String? iso) {
    final at = iso == null ? null : DateTime.tryParse(iso)?.toLocal();
    if (at == null) return iso ?? '?';
    String two(int value) => value.toString().padLeft(2, '0');
    return '${two(at.month)}-${two(at.day)} ${two(at.hour)}:${two(at.minute)}';
  }

  /// [autostartGaveUp]'s time, from the status report's ISO time.
  String clockOf(String iso) => _clock(iso);
  // Which step of the start did not finish. [step] is a startupStage sentence.
  String startFailedAtStep(String step, String reason) => _t(
      '没有启动成功，卡在「${step.replaceAll('…', '')}」：$reason',
      'FULI did not start; it stopped at "${step.replaceAll('…', '')}": $reason');
  // The graph service here was set up by a newer FULI (runtime/provider_conflict.dart); nothing was changed.
  String startFailedNewerData(String installed, String current) => _t(
      '没有启动：这里的数据是更新的 FULI（$installed）保存的，现在是 $current。数据没有改动，更新 FULI 后再启动。',
      'FULI did not start: a newer FULI ($installed) set up the data on this computer; this one is $current. '
          'Nothing was changed. Update FULI, then start again.');
  String stopFailed(String reason) => _t('没有停止成功：$reason', 'FULI did not stop: $reason');
  // Windows reserves some ports; the controller can move FULI to a free one.
  String startFailedPortBlocked(String reason) => _t('没有启动成功：Windows 保留了 FULI 的端口。在托盘菜单选「换一个端口」再试。$reason',
      'FULI did not start: Windows reserves its port. Choose Use another port in the tray menu and try again. $reason');
  String get portChanged => _t('已换端口并重启 FULI。', 'FULI moved to another port and restarted.');
  String portChangeFailed(String reason) => _t('没有换成端口：$reason', 'The port did not change: $reason');
  String actionFailed(String reason) => _t('没有完成：$reason', 'Did not finish: $reason');
  String sentences(String first, String second) => chinese ? '$first$second' : '$first $second';

  // macOS: FULI.app opened from its disk image offers to move itself
  String get moveToApplications => _t('移到「应用程序」', 'Move to Applications');
  String get notNow => _t('这次不移', 'Not now');
  String get movingToApplications => _t('正在移到「应用程序」…', 'Moving to Applications…');
  String get moveFailed => _t('没能移到「应用程序」，这次在这里打开 FULI。', 'Could not move to Applications; open FULI from here this time.');

  // Windows: this window runs a version an update replaced
  String get oldVersionWindow => _t('这是旧版本的 FULI。', 'This window is an older version of FULI.');
  String get openNewVersion => _t('打开新版本', 'Open the new version');
  String get openingNewVersion => _t('正在打开新版本…', 'Opening the new version…');
  String get openNewVersionFailed =>
      _t('没能打开新版本，请关掉这里，重新打开 FULI。', 'Could not open the new version; close this and open FULI again.');

  // Data format dialog (the console's 数据格式迁移 page, in short)
  String get migrationTitle => _t('确认数据格式变化', 'Confirm the data format change');
  String get migrationLoading => _t('正在读取要变化的数据…', 'Reading what will change…');
  String migrationLoadFailed(String reason) =>
      _t('没有读取到要变化的数据：$reason', 'Could not read what will change: $reason');
  String get migrationIntro => _t('FULI 只在你确认后改写已有数据。下面是会变化的存储、步骤和记录数量，不含记录内容。',
      'FULI rewrites existing data only after you confirm. These are the stores, steps and record counts that change; record content is not shown.');
  String migrationStoreLine(int? from, int? to, int count) =>
      _t('版本 ${from ?? '?'} → ${to ?? '?'} · $count 条记录', 'Version ${from ?? '?'} → ${to ?? '?'} · $count records');
  String get migrationSamples => _t('示例 ID', 'Sample IDs');
  String get migrationUndoAvailable => _t('可撤销（只放回这次改动的记录）', 'Can be undone (only the records this change touched)');
  String get migrationUndoRestoreOnly => _t('不能单独撤销，只能整库恢复', 'Cannot be undone on its own; only a whole-store restore');
  String get migrationBlocked => _t('FULI 不能在这里处理', 'FULI cannot handle these here');
  String get migrationNothing => _t('没有等待确认的数据格式变化。', 'No data format change is waiting.');
  String migrationDigest(String digest) => _t('计划摘要 $digest…', 'Plan digest $digest…');
  String get migrationConfirm => _t('确认应用', 'Apply');
  String get migrationApplying => _t('正在应用数据格式变化…', 'Applying the data format change…');
  String get migrationStale => _t('计划在你确认前有了变化，没有做任何修改。下面是重新读取的计划，请重新确认。',
      'The plan changed before you confirmed, so nothing was changed. This is the plan read again; confirm it again.');
  String get migrationApplied => _t('已应用。', 'Applied.');
  String migrationNotApplied(String reasons) => _t('有存储没有应用：$reasons', 'Some stores were not changed: $reasons');
  String get cancel => _t('取消', 'Cancel');
  String get close => _t('关闭', 'Close');

  // Doctor items: one plain sentence each; never the raw kind as the main text.
  String explain(DoctorItem item) {
    final data = item.data;
    String text(String key) => data[key] is String ? data[key] as String : '';
    final client = clientName(text('label').isNotEmpty ? text('label') : text('clientId'));
    final store = text('label').isNotEmpty ? text('label') : text('store');
    return switch (item.kind) {
      'client_outdated' => _t('$client 接入 FULI 的设置已过期，需要重新接入。',
          "$client's FULI connection is out of date and needs to be connected again."),
      // lastSeenAt: the graph's answer from before it went idle; it still blocks every write.
      'data_format_waiting' => text('lastSeenAt').isNotEmpty
          ? _t('$store 的数据要换成新格式，FULI 等你看过后确认。这是它空闲前的状态；确认之前 FULI 写不进去。',
              '$store data needs a new format; FULI waits for you to review and confirm it. This is what it reported before going idle; FULI cannot write to it until you confirm.')
          : _t('$store 的数据要换成新格式，FULI 等你看过后确认。',
              '$store data needs a new format; FULI waits for you to review and confirm it.'),
      'data_format_blocked' => _t('$store 的数据格式 FULI 不能自动处理，请在控制台的「数据格式迁移」里查看原因。',
          'FULI cannot change the $store data format by itself; see why under Data format in the console.'),
      'sessions_outdated' => _sessionsOutdated(clientName(text('client')), data['count'], text('runningVersion')),
      'update_available' => _t('FULI 有新版本 v${text('latest')}。', 'FULI v${text('latest')} is available.'),
      'update_left_work' => data['status'] == 'failed'
          ? _t('上次更新没有完成。', 'The last update did not finish.')
          : _t('更新到 v${text('version')} 后，还有 Agent 没有重新接入 FULI。',
              'After the update to v${text('version')}, some Agents have not reconnected to FULI.'),
      'ports_moved' => _portsMoved(data['moves']),
      // On Windows other accounts or sandboxes can open the data folder (src/system/windows-data-acl.js).
      'data_dir_shared' => _t('数据文件夹别的用户能读取。自动修复后只有你和系统能打开。',
          'Other accounts can read the data folder. Fixing automatically limits it to you and the system.'),
      // An older install's Docker graph (src/system/graph-migration.js), moved from the console's Settings.
      'graph_container' => _t('你的数据还在旧版 Docker 图数据库里，请在控制台「设置」里迁移。',
          "Your knowledge is still in the old Docker graph; move it with one click in the console's Settings."),
      _ => _t('FULI 发现一件需要处理的事，打开控制台可以看到详情。', 'FULI found something to take care of; open the console for details.'),
    };
  }

  // The ports FULI's last start moved by itself (src/system/blocked-port-recovery.js):
  // the console's own move when there is one, otherwise the graph services'.
  String _portsMoved(Object? moves) {
    final list = moves is List ? moves.whereType<Map>().toList() : const <Map>[];
    final console = list.where((move) => move['key'] == 'console').firstOrNull;
    if (console == null || console['from'] is! int || console['to'] is! int) {
      return _t('有端口不能用，FULI 已自动给图谱服务换了端口，不用你做什么。',
          'Some ports could not be used, so FULI moved its graph services to other ports by itself. Nothing to do.');
    }
    final from = console['from'];
    final to = console['to'];
    return console['reason'] == 'in_use'
        ? _t('端口 $from 被别的程序占用，FULI 已自动改用 $to，不用你做什么。',
            'Another program uses port $from, so FULI moved to port $to by itself. Nothing to do.')
        : _t('端口 $from 被系统保留，FULI 已自动改用 $to，不用你做什么。',
            'Port $from is reserved by the system, so FULI moved to port $to by itself. Nothing to do.');
  }

  String _sessionsOutdated(String client, Object? count, String version) {
    final sessions = count is int && count > 0 ? count : null;
    final zhCount = sessions == null ? '有' : '有 $sessions 个';
    final enCount = sessions == null ? 'Some' : (sessions == 1 ? '1' : '$sessions');
    final zhVersion = version.isEmpty ? '旧版 FULI' : '旧版 FULI（v$version）';
    final enVersion = version.isEmpty ? 'an older FULI' : 'FULI v$version';
    return _t('$zhCount $client 会话还在用$zhVersion。关掉并重新打开 $client 即可。',
        '$enCount $client ${sessions == 1 ? 'session still uses' : 'sessions still use'} $enVersion. Close and reopen $client.');
  }

  // Display names of the Agent clients FULI connects (src/agents/source-applications.js).
  static String clientName(String id) => switch (id) {
        'codex' => 'Codex',
        'claude_code' => 'Claude Code',
        'claude' => 'Claude',
        'cursor' => 'Cursor',
        'gemini_cli' => 'Gemini CLI',
        'kiro' => 'Kiro',
        'opencode' => 'OpenCode',
        'antigravity' => 'Antigravity',
        'dsh' => 'DeepSeek Harness',
        '' => 'Agent',
        _ => id,
      };
}
