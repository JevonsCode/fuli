import { statSync } from 'node:fs';

import { TASK_RULES_ON_DEMAND } from '../agents/lifecycle-message.js';
import { currentTaskPreferences, currentTaskStatus, preferenceHookOutput } from './preference-lifecycle.js';
import { skipTranscriptSpan, TURN_UNRESOLVED } from './transcript-capture-gap.js';
import { transcriptDigest } from './transcript-guard.js';
import { initialTranscriptBoundary, verifiedTranscriptEnd } from './transcript-reader.js';

// A prompt turn whose task transition cannot be proven (rec#15), for every
// Agent: it is answered about the current task instead of entering, it is held
// as unresolved before anything else can fail, and its Stop neither settles
// the session's task nor records the turn under it until the turn is resolved.
// Each Agent's hook decides which turns these are (its turnOrigin: host_event
// or host_system; one it cannot tell is the person's) and what proves a
// continuation; the ledger is transcript-capture-gap.js.

// The native byte an unresolved turn begins after: the transcript's length
// when its prompt reaches the hook. Unreadable or absent is 0, which only looks wider.
export function turnStart(transcriptPath) {
  try { return statSync(transcriptPath).size; } catch { return 0; }
}

// Each Agent's hook passes its own policy for these turns, one object for the
// mechanism and what the model is told about it, so the guidance can only
// promise a resolution the host's Stop actually performs:
//   sourceApplication, adapter  the Agent and its native transcript adapter
//   unconfirmed  bilingual sentence: why this turn's ownership is not confirmed
//   resolution   what the refreshed task's token can and cannot do for this turn
//   inlineChars, inlineBytes  the host's inline limit for the refreshed context,
//     if it has one, in UTF-16 code units or UTF-8 bytes (preferenceHookOutput)
//   continuedInTurn(input, token, from)  the Agent's evidence of an explicit
//     continuation in its native history; without one no turn is ever proven

// A host turn: one the Agent's adapter reads as not a person's prompt
// (`turnOrigin` 'host_event', such as a background task's notification, or
// 'host_system', a host system delivery). It never begins or switches a task,
// so an unfinished task keeps its checkpoint, and it never claims that this
// turn belongs to that task; without a readable owned task it establishes
// none. onCurrentTask names the task found. The model already holds what this
// session was given, so the turn is told so in one line and nothing is read,
// scoped or delivered (design T1: 155 notifications of one session resent 123k
// characters). Only a session this context generation has given nothing yet
// (a compaction whose restore failed, an unreadable delivery record, or no
// delivery at all) re-reads the current task in place and gets it whole, as a
// task entry would: a missed preference costs more than a resent one.
export async function refreshCurrentTaskInPlace(event, input, invoke,
  { sourceApplication, unconfirmed, resolution, inlineChars = null, inlineBytes = null }, { turnOrigin, delivery, currentTask, onCurrentTask }) {
  let refresh;
  try {
    const task = await currentTask?.(input.session_id, sourceApplication);
    if (task) await onCurrentTask?.(task);
    const status = currentTaskStatus(task, input, sourceApplication);
    if (status) refresh = { status };
    else if (await delivery?.delivered({ sourceApplication, nativeSessionId: input.session_id, transcriptPath: input.transcript_path })) {
      return { hookSpecificOutput: { hookEventName: event, additionalContext: hostTurnLine(turnOrigin) } };
    } else refresh = await currentTaskPreferences(input, { sourceApplication, currentTask: async () => task, invoke });
  } catch (error) {
    // Only the reader's own refusal text is shown; other failures stay private.
    refresh = { status: 'unreadable', reason: error?.code === 'preference_recovery_blocked' ? error.message : null };
  }
  return refresh.status === 'refreshed' ? preferenceHookOutput(refresh.context, event, input, delivery, sourceApplication,
    `${unconfirmed} ${resolution} ${START_NEW_WORK} ${TASK_RULES_ON_DEMAND}`, false, { inlineChars, inlineBytes })
    : { hookSpecificOutput: { hookEventName: event, additionalContext: noValidContext(refresh) } };
}

// Bilingual: the person reads it in the transcript as well as the model. It
// names the entry call it makes unnecessary: the MCP instructions tell a model
// whose hook supplied no task context to call it.
const HOST_TURN = Object.freeze({ host_event: ['宿主事件', 'a host event'], host_system: ['宿主系统消息', 'a host system message'] });
function hostTurnLine(turnOrigin) {
  const [zh, en] = HOST_TURN[turnOrigin];
  return `FULI：本轮是${zh}，非人发消息；当前任务和已下发的上下文仍有效，不必再取。 `
    + `FULI: ${en}, not a person's message; the current task and given context still apply: no get_collaboration_preferences call.`;
}

function noValidContext(refresh) {
  const [zh, en] = NO_VALID_CONTEXT[refresh.status];
  return `FULI：本轮没有建立有效的任务上下文（${zh}），没有创建或切换任务。 FULI: no valid task context is established for this turn `
    + `(${en}${refresh.reason ? `: ${refresh.reason}` : ''}); no task was created or switched. `
    + (refresh.status === 'task_closed' ? CONTINUE_CLOSED_WORK : START_NEW_WORK);
}

// A refresh turn whose unresolved state could not be kept anywhere does not
// reach the model: it would otherwise run unprotected. `why` names, in Chinese
// and English, what made the hook treat the message as such a turn.
export function unprotectedTurnReason(why) {
  return `FULI 拦下了这条消息，没有交给模型：${why.zh}，FULI 需要先记下“本轮任务归属未确认”，`
    + '但 FULI 数据目录里的 transcript-capture/ 和 transcript-turn-holds/ 都写不进去（磁盘已满、没有写权限，或另一个 FULI 进程一直占着锁）。'
    + '恢复：确认数据目录可写、有空间，并且没有卡住的 FULI 进程，然后需要的话自己重新发送这条消息。FULI 不会自动重发，宿主通知也不会被补发。 '
    + `FULI held this message back and did not pass it to the model: ${why.en}, and FULI must first record `
    + 'that the task ownership of this turn is unresolved, but neither transcript-capture/ nor transcript-turn-holds/ in the FULI data '
    + 'directory could be written (disk full, no write permission, or another FULI process holding the lock). To recover, make the '
    + 'data directory writable with free space and no stuck FULI process, then resend the message yourself if you still need it. '
    + 'FULI does not resend it, and a host notification is not redelivered.';
}

// Bilingual where the person reads it too; this part is for the model.
export const START_NEW_WORK = 'If this turn is new work, start a task explicitly with get_collaboration_preferences '
  + '(projectPath = current working directory, taskPrompt = the request) and use the taskContextToken it returns.';
// A host notification (a background task finished, a CI event) after the
// session's task was closed when its last turn ended: the middle of a long
// piece of work, with no token left to checkpoint it (coordinator, from real
// use). It never reopens the closed task, whose turn this one may not be;
// it says how to continue in one call, and that the old token is closed.
export const CONTINUE_CLOSED_WORK = 'The task this session was working on was closed when its last turn ended (the Stop '
  + 'hook closes a turn that recorded no checkpoint), so its taskContextToken can no longer checkpoint. If this turn '
  + 'continues that work, call get_collaboration_preferences now (projectPath = current working directory, taskPrompt = '
  + 'one line saying what this turn continues and what the notification reports) and use the taskContextToken it '
  + 'returns for everything in this turn, the checkpoint included. If it is new work, do the same with the request.';
const NO_VALID_CONTEXT = Object.freeze({
  no_task: ['本会话没有当前任务', 'this session has no current task'],
  task_closed: ['本会话的当前任务已关闭', 'the current task of this session is closed'],
  other_session: ['当前任务属于其他会话', 'the current task belongs to another session'],
  fuli_off: ['本会话已停用 FULI', 'FULI is off for this session'],
  unreadable: ['当前任务的归属或范围无法确认', 'the current task\'s ownership or scope could not be confirmed']
});

// What this Stop may do about the session's held turns: 'held' settles and
// records nothing, 'normal' lets it run. Held turns end only by evidence from
// the last of them: a successful explicit continuation of the task it was
// current for, which the Provider confirms (that turn is then imported under
// the task, everything before it only as a skipped span), or another task,
// or none, being current (all of it is skipped). A state that cannot be
// proven, an unknown owner or a failed lookup or skip keeps them held. A
// policy without continuedInTurn never proves a turn.
export async function settleHeldTurns(application, ledger, input, currentTask,
  { sourceApplication, adapter, continuedInTurn = () => false }) {
  const held = ledger?.heldTurns();
  if (!held) return 'normal';
  if (held.unprovable) return 'held';
  const skipUntil = end => skipTranscriptSpan(application, input, sourceApplication, TURN_UNRESOLVED, end);
  if (!held.turns.length) {
    if (held.skipUntil === null) return 'normal';
    if ((await skipUntil(async () => held.skipUntil)).status === 'failed') return 'held';
    ledger.skipped(held.skipUntil);
    return 'normal';
  }
  const latest = held.turns.at(-1);
  let task;
  try { task = await currentTask?.(input.session_id, sourceApplication); } catch { return 'held'; }
  if (task === undefined) return 'held';
  const moved = !task || (latest.owner !== null && transcriptDigest(task.token) !== latest.owner);
  const proven = !moved && latest.owner !== null && task.checkpoint?.phase === 'complete'
    && continuedInTurn(input, task.token, latest.from);
  if (!moved && !proven) return 'held';
  const end = moved ? () => verifiedTranscriptEnd(input.transcript_path, input.session_id, adapter)
    : async () => latest.from;
  if ((await skipUntil(end)).status === 'failed') return 'held';
  return ledger.endTurns(latest.turn) ? 'normal' : 'held';
}

// Turns held when a prompt started (`held`, the ledger's entry snapshot) end
// once that prompt freshly entered a task: only those, so a turn held while
// the entry ran stays held. Nothing before the prompt may be imported later
// either. A boundary that cannot be read keeps them held, and so does an
// entry without a transcript path: an empty field is no proof that the
// session has no history, and a later hook may bring the path back with the
// held span still unskipped (dot, #276).
export async function endTurnsObservedAtEntry(ledger, held, input, { adapter }) {
  if (!held?.any || typeof input.transcript_path !== 'string' || !input.transcript_path.trim()) return;
  const before = await initialTranscriptBoundary(input.transcript_path, input.session_id, input.prompt, adapter)
    .catch(() => null);
  if (before !== null) ledger.enteredAfter(before, held);
}
