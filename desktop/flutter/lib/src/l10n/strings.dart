import '../doctor/doctor_report.dart';

// Every sentence the client shows, in Chinese and English, chosen once from
// the system locale. Each entry keeps both languages side by side.
class Strings {
  const Strings({required this.chinese});

  factory Strings.forLanguage(String languageCode) => Strings(chinese: languageCode == 'zh');

  final bool chinese;

  String _t(String zh, String en) => chinese ? zh : en;
  String _things(int count) => count == 1 ? '1 thing' : '$count things';

  // Status sentence
  // The desktop client is a Beta feature for now: its window and tray say so.
  String get appName => 'FULI Beta';
  String get checking => _t('正在检查 FULI…', 'Checking FULI…');
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
  String get notFoundBody => _t('这台电脑上没有找到 FULI 的安装。', 'No FULI installation was found on this computer.');
  String get noAnswer => _t('FULI 在运行，但控制台没有应答。', 'FULI is running, but its console does not answer.');
  String consoleError(String detail) => _t('控制台回答出错：$detail', 'The console answered with an error: $detail');

  // Buttons and menu
  String get autoRepair => _t('自动修复', 'Fix automatically');
  String autoRepairHint(int count) =>
      _t('$count 件事可以自动修复', '${_things(count)} can be fixed automatically');
  String get sectionNeedsYou => _t('需要你处理', 'Needs you');
  String get sectionNotes => _t('提示', 'For your information');
  String get review => _t('查看并确认', 'Review and confirm');
  String updateTo(String version) => _t('更新到 v$version', 'Update to v$version');
  String get openConsole => _t('打开控制台', 'Open console');
  String get startFuli => _t('启动 FULI', 'Start FULI');
  String get stopFuli => _t('停止 FULI', 'Stop FULI');
  String get openFuli => _t('打开 FULI', 'Open FULI');
  String get quit => _t('退出', 'Quit');
  String get installPage => _t('打开安装页', 'Open the install page');
  // Windows tray menu only
  String get changePort => _t('换一个端口', 'Use another port');
  String get launchAtLogin => _t('开机时启动', 'Launch at login');

  // What is running right now
  String reconnecting(String client) => _t('正在重新接入 $client…', 'Reconnecting $client…');
  String get reconnectingAgents => _t('正在重新接入 Agent…', 'Reconnecting Agents…');
  String get repairingOne => _t('正在修复…', 'Fixing…');
  String repairingMany(int count) => _t('正在修复 $count 件事…', 'Fixing ${_things(count)}…');
  String get starting => _t('正在启动 FULI…', 'Starting FULI…');
  String get stopping => _t('正在停止 FULI…', 'Stopping FULI…');
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
  String stopFailed(String reason) => _t('没有停止成功：$reason', 'FULI did not stop: $reason');
  // Windows reserves some ports; the controller can move FULI to a free one.
  String startFailedPortBlocked(String reason) => _t('没有启动成功：Windows 保留了 FULI 的端口。在托盘菜单选「换一个端口」再试。$reason',
      'FULI did not start: Windows reserves its port. Choose Use another port in the tray menu and try again. $reason');
  String get portChanged => _t('已换端口并重启 FULI。', 'FULI moved to another port and restarted.');
  String portChangeFailed(String reason) => _t('没有换成端口：$reason', 'The port did not change: $reason');
  String actionFailed(String reason) => _t('没有完成：$reason', 'Did not finish: $reason');
  String sentences(String first, String second) => chinese ? '$first$second' : '$first $second';

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
      _ => _t('FULI 发现一件需要处理的事，打开控制台可以看到详情。', 'FULI found something to take care of; open the console for details.'),
    };
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
        '' => 'Agent',
        _ => id,
      };
}
