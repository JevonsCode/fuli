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
    final operation = failure.text('operation');
    final seconds = failure.number('seconds') ?? 60;
    return switch (failure.code) {
      // A switch journal waits for recovery: never a reason to release the lock.
      // What happened, what state the data is in, what not to do: FULI has no
      // way to finish or undo the switch (src/native-runtime/neo4j-lifecycle.js).
      'native_recovery_needed' => _t(
          '没有启动：有一次数据库${_operation(operation)}没做完。知识数据还在原来的位置，没有被复制或覆盖。FULI 现在没有能完成或撤销这一步的办法，需要人来恢复；在那之前不要删除数据库维护锁，也不要用别的版本的 FULI 打开这份数据。',
          'FULI did not start: a database ${operation ?? 'switch'} did not finish. Your knowledge data is still where it was and was not copied or overwritten. '
              'FULI has no way to finish or undo this step yet, so a person needs to recover it; until then, do not remove the maintenance lock or open this data with another FULI version.'),
      'native_lifecycle_lock' => switch (failure.text('holder')) {
          'running' => _t('没有启动：数据库维护锁从 $since 起被进程 $pid${_named(failure)}占着。等它结束后再点「启动 FULI」。',
              'FULI did not start: process $pid${_named(failure)} has held the database maintenance lock since $since. Choose Start FULI once it has ended.'),
          'gone' => _t('没有启动：一次数据库${_operation(operation)}在 $since 中途停了，留下了维护锁；知识数据没有被改动。它可能留下了装了一半的文件，所以 FULI 不会解除这把锁，需要人来处理。',
              'FULI did not start: a database ${operation ?? 'operation'} stopped part way at $since and left its maintenance lock; your knowledge data was not changed. '
                  'It may have left files half installed, so FULI does not release the lock; a person needs to handle it.'),
          _ => _t('没有启动：数据库维护锁从 $since 起一直没放开，没有记录是谁加的。',
              'FULI did not start: the database maintenance lock has been held since $since with no record of who took it.'),
        },
      'port_taken' => _portTaken(failure),
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

  // The operation a lock or journal names, in a Chinese sentence.
  String _operation(String? operation) =>
      const {'update': '更新', 'rollback': '回退', 'uninstall': '卸载', 'admin': '导出或导入'}[operation] ?? '切换';

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
  // (src/native-runtime/neo4j-lifecycle-lock.js).
  bool releasableLock(StartupFailure failure) =>
      failure.code == 'native_lifecycle_lock' && failure.text('holder') == 'unknown';

  // Fits the status bar's primary place (status_actions.dart `_primaryWidth`).
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
      _ => _t('锁没有解除：它在核对时被换掉了。', 'The lock was kept: it changed while it was being checked.'),
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
