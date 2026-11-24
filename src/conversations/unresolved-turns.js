import { statSync } from 'node:fs';

import { skipTranscriptSpan, TURN_UNRESOLVED } from './transcript-capture-gap.js';
import { transcriptDigest } from './transcript-guard.js';
import { initialTranscriptBoundary, verifiedTranscriptEnd } from './transcript-reader.js';

// A prompt turn whose task transition cannot be proven (rec#15), for every
// Agent: it contributes no task context, it is held
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

// Remember which task a notification interrupted so Stop can check its owner.
// A lookup failure leaves the hold unresolved. A notification never participates
// in entry delivery, even when there is no current task or recorded frame.
export async function quietHostTurn(currentTask, onCurrentTask) {
  if (onCurrentTask) {
    try {
      const task = await currentTask();
      if (task) await onCurrentTask(task);
    } catch { /* Stop keeps a turn with unknown ownership held. */ }
  }
  return {};
}

// A host turn whose unresolved state could not be kept anywhere does not
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
