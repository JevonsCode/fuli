// What a person is told when automatic recording did not run (rec#11 D-01,
// rec#5 C5). Edits the person submits explicitly are not automatic recording
// and still save, so every notice says so. A notice names the decision and any
// explicit operation that still ran, never anything that was not recorded. One
// wording for every Agent: the receipt carries it on every turn while it applies.
const EXPLICIT_EDITS_SAVED = '你明确提交的修改仍会保存';
const REASON_NOTICES = Object.freeze({
  policy_unavailable: '记录设置读取失败，本次未自动记录',
  project_off: '此项目未开启记忆',
  project_unregistered: '当前目录不是 FULI 项目，未自动记录',
  // Not this session's pause: the client's FULI connection still names the
  // session before /clear (capture-decision.js).
  session_binding_stale: 'FULI 绑定的是 /clear 之前的会话，本会话的自动记录暂不可用；重启客户端或新开会话即可恢复',
  // rec#5 C3b: new sessions start with FULI off until the person starts it.
  session_not_started: '本会话未启用 FULI（新会话默认不启用），输入 /fuli start 可启用',
  // The default this session started under could not be saved, so it stays off.
  session_start_unsaved: 'FULI 未能保存本会话开始时的设置，本会话保持停用，输入 /fuli start 可启用',
  // The call carries no task token and its client cannot say which session it
  // is, while one of that client's sessions has FULI off (session-layer-decision.js).
  session_unattributed: 'FULI 无法确认这次调用来自哪个会话，而本客户端有会话已停用 FULI，所以没有提供'
});
// The global and client switches, and any reason without wording of its own.
const RECORDING_OFF = '自动记录已关闭';
const EXPLICIT_OPERATION_RESULTS = Object.freeze({ project_created: '已创建项目，会话未记录' });

// What a hook says about the transcript itself (transcript-capture-gap.js): a
// stretch skipped because the settings changed while it was written, or a
// denial that could not be kept safely, in a new settings generation
// (unsaved) or nowhere local at all (unwritable).
const TRANSCRIPT_NOTICES = Object.freeze({
  capture_changed: '记录设置有变动，无法确认这段是否允许记录，已跳过',
  capture_state_unsaved: '记录状态未能安全保存，本会话后续内容暂不导入',
  capture_state_unwritable: '记录状态无法写入本地，本会话后续内容暂不导入；修复本地写入前，新的进程可能无法识别这段未记录的内容，请手动检查'
});

// reason is a capture decision's denial or one of the transcript states above;
// since is when a session pause (rec#5 C5) or stop (C3b) began, in local time.
export function captureNotice(reason, since = null) {
  if (!reason) return null;
  if (reason === 'session_paused') return `${sinceNotice('本会话已暂停记录', since)}；${EXPLICIT_EDITS_SAVED}`;
  if (reason === 'session_stopped') return `${sinceNotice('本会话已停用 FULI', since)}，输入 /fuli start 可重新启用；${EXPLICIT_EDITS_SAVED}`;
  return TRANSCRIPT_NOTICES[reason] ?? `${REASON_NOTICES[reason] ?? RECORDING_OFF}；${EXPLICIT_EDITS_SAVED}`;
}

// A checkpoint retried after its first attempt keeps that attempt's decision
// without its time, so the notice still says the session is paused or stopped.
export function sinceNotice(text, since) {
  const at = since ? new Date(since) : null;
  if (!at || Number.isNaN(at.getTime())) return text;
  const pad = value => String(value).padStart(2, '0');
  return `${text}（自 ${pad(at.getHours())}:${pad(at.getMinutes())} 起）`;
}

// A receipt's notices for one turn: the decision, then each explicit operation
// the person asked for that ran while automatic recording was off.
export function receiptNotices(decision, explicitOperations = []) {
  const notice = captureNotice(decision.reason, decision.since);
  return notice ? [notice, ...explicitOperations.map(operation => EXPLICIT_OPERATION_RESULTS[operation])] : [];
}
