import { requiredBinding } from '../validation/values.js';
import { captureDecision } from './capture-decision.js';
import { captureNotice, sinceNotice } from './capture-notice.js';
import { keptInSessionLedger } from './session-capture-pause-request.js';
import { newSessionsFuli, sessionFuliState } from './session-layer-decision.js';

// The person's own /fuli start|stop|restart|status for one host session
// (rec#5 C3b). The session is the host's: the lifecycle hook that saw the
// person type the line, or the client environment the CLI runs in, never a
// session a model names. stop turns off, for this session only, memory
// injected at task entry, automatic recording and collaboration the session
// would start; it closes no service, touches no other session and deletes no
// memory. start turns it back on within the existing settings, which it never
// widens: a stricter global, client, project or pause setting still applies.
// restart is start plus a full context at the next entry. Nothing said while
// FULI was off is recorded later. Each answer is the state after the request,
// read back, never the state asked for; a repeated request changes nothing.

export const SESSION_FULI_ACTIONS = Object.freeze(['start', 'stop', 'restart', 'status']);
// Turns written while FULI was off, or up to a switch, are never imported:
// the same content-free ledger entry a pause keeps.
const LEDGER_REASON = 'session_stopped';

export async function switchSessionFuli(application, { sessionId, sourceApplication, action, projectPath = null }) {
  if (!SESSION_FULI_ACTIONS.includes(action)) throw new TypeError(`Unknown FULI session action: ${action}`);
  // The hook's or the CLI's own host session, never one a caller names.
  requiredBinding(sessionId, 'Host session');
  requiredBinding(sourceApplication, 'Client');
  const before = readState(application, sessionId);
  if (!before) return answer('unavailable', action, null);
  const scope = { sessionId, sourceApplication, projectPath };
  if (action === 'status') return answer('status', action, before, await recording(application, scope));
  const enabled = action !== 'stop';
  // A stop said in the session that started this one is that session's to lift.
  if (enabled && !before.enabled && before.basis === 'parent') return answer('parent_stopped', action, before);
  if (before.enabled !== enabled) {
    const saved = await keptInSessionLedger(application, sourceApplication, sessionId, LEDGER_REASON)
      && savedSwitch(application, sessionId, { enabled, sourceApplication });
    if (!saved) return answer('unsaved', action, readState(application, sessionId));
  }
  // A full context next turn is promised only when the delivery was reset.
  const fullContext = action === 'restart'
    ? await application.preferenceDelivery?.reset({ sourceApplication, nativeSessionId: sessionId }) ?? true : null;
  const after = readState(application, sessionId);
  if (!after || after.enabled !== enabled) return answer('unsaved', action, after);
  const changed = before.enabled !== enabled;
  const status = action === 'restart' ? (fullContext ? 'restarted' : 'restarted_without_full_context') : enabled ? (changed ? 'started' : 'already_started')
    : changed ? 'stopped' : 'already_stopped';
  return answer(status, action, after, await recording(application, scope));
}

// Whether new sessions start with FULI on (newSessions on or off), or what
// they do now (status). Sessions already open keep the default they started under.
export function requestSessionFuliDefault(application, { newSessions }) {
  if (!['on', 'off', 'status'].includes(newSessions)) throw new TypeError('newSessions must be on, off or status');
  if (newSessions !== 'status') {
    try {
      application.setSessionFuliDefault(newSessions === 'on');
    } catch { /* read back below */ }
  }
  let current;
  try {
    current = newSessionsFuli(application);
  } catch {
    return { status: 'unavailable', newSessions: null, message: 'FULI 无法读取新会话的默认设置；读到之前，新会话不会自动记录。' };
  }
  if (newSessions !== 'status' && current !== newSessions) {
    return { status: 'unsaved', newSessions: current, message: `FULI 未能保存新会话的默认设置，仍为${label(current)}。` };
  }
  return { status: newSessions === 'status' ? 'status' : 'saved', newSessions: current,
    message: `新会话默认${label(current)} FULI${newSessions === 'status' ? '' : '；已打开的会话不受影响'}。` };
}

const label = newSessions => newSessions === 'on' ? '启用' : '不启用';

function readState(application, sessionId) {
  try {
    return sessionFuliState(application, sessionId);
  } catch {
    return null;
  }
}

function savedSwitch(application, sessionId, change) {
  try {
    application.setSessionFuli(sessionId, change);
    return true;
  } catch {
    return false;
  }
}

// What automatic recording of the session does now: FULI being on does not
// mean recording is, when another layer or a pause says no.
async function recording(application, scope) {
  const decision = await captureDecision(application, scope);
  return { captured: decision.allowed, reason: decision.reason, notice: captureNotice(decision.reason, decision.since) };
}

function answer(status, action, fuli, recordingNow = null) {
  return { status, action, fuli, ...(recordingNow ? { recording: recordingNow } : {}),
    message: [MESSAGES[status](fuli), recordingLine(fuli, recordingNow), NOTED.has(status) ? SWITCH_NOTE : null]
      .filter(Boolean).join(' ') };
}

function recordingLine(fuli, recordingNow) {
  return fuli?.enabled && recordingNow && !recordingNow.captured ? `自动记录仍未开启：${recordingNow.notice}。` : null;
}

const STOP_EFFECT = '之后不再注入记忆、不再自动记录、不再由本会话自动发起协作；其他会话、全局服务和已有记忆不受影响。'
  + '已在运行的动作不会被撤回，它之后的结果不再自动记录或触发协作。'
  + '输入 /fuli start 可重新启用。';
// Said with every answer about the switch (Fable review of #251): what a stop
// cannot do, and who else can turn it.
const SWITCH_NOTE = '须知：停用不会撤回已发给模型的上下文，需要完全隔离请新开会话；'
  + '能运行 shell 的 Agent 也能执行 `fuli session …` 改变这个开关，与它能读写本地文件属同等信任。';
const NOTED = new Set(['stopped', 'already_stopped', 'started', 'already_started', 'restarted',
  'restarted_without_full_context', 'status']);
const MESSAGES = Object.freeze({
  stopped: fuli => `${sinceNotice('FULI 已在本会话停用', fuli.since)}：${STOP_EFFECT}`,
  already_stopped: fuli => fuli.basis === 'default'
    ? 'FULI 在本会话本来就未启用（按本会话开始时的默认设置），未重复执行。输入 /fuli start 可启用。'
    : fuli.basis === 'start_unsaved' ? 'FULI 在本会话保持停用（未能保存本会话开始时的设置），未重复执行。输入 /fuli start 可启用。'
    : `${sinceNotice('FULI 在本会话已是停用状态', fuli.since)}，未重复执行。`,
  started: () => 'FULI 已在本会话启用：之后按现有权限和设置注入记忆、自动记录和协作；停用期间的对话不会补录。',
  already_started: () => 'FULI 在本会话已是启用状态，未重复执行。',
  restarted: () => 'FULI 已在本会话重新启用，下一轮重新提供完整上下文；已有记录保留，停用期间的对话不会补录。',
  restarted_without_full_context: () => 'FULI 已在本会话重新启用，但未能重置上下文投递，下一轮可能只提供变化的部分而不是完整上下文；'
    + '已有记录保留，停用期间的对话不会补录。需要完整上下文时请再输入一次 /fuli restart。',
  parent_stopped: () => '本会话由已停用 FULI 的会话发起，需要先在发起它的会话中启用；状态未改变。',
  unsaved: fuli => `FULI 未能保存本会话的启停状态，状态未改变${fuli ? `（当前${fuli.enabled ? '启用' : '停用'}）` : ''}。`,
  unavailable: () => 'FULI 无法读取本会话的启停状态，本会话不会自动记录；请稍后重试或检查本地数据目录。',
  status: fuli => `FULI 在本会话${fuli.enabled ? '已启用' : fuli.basis === 'default' ? '未启用（按本会话开始时的默认设置）'
    : fuli.basis === 'start_unsaved' ? '保持停用（未能保存本会话开始时的设置）'
    : sinceNotice('已停用', fuli.since)}；新会话默认${fuli.newSessions === 'on' ? '启用' : '不启用'}。`
});
