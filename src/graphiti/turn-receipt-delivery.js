import { deferredTurnReceipt, readTurnReceipt, savedEpisodeIds } from '../agents/turn-receipt.js';

// When a turn's receipt reaches a reply, exactly once (rec#20). The Provider
// marks a checkpoint that saved knowledge as unread. Its own reply claims it
// after reading it back; a retry of that checkpoint claims it again and shows
// the same lines. When the reply could not carry it (reading back or claiming
// failed, or the call failed after saving) it stays unread. The session's next
// task entry reads it back first and claims it only then, so one that cannot be
// read yet stays unread for a later entry; it is shown once, marked as late.

// The receipt of a completed checkpoint, or null when it saved nothing new.
// memory: the Agent working-memory write this checkpoint made, if any.
export async function checkpointTurnReceipt(application, task, { memory = null, agentName = null } = {}) {
  const results = task.checkpoint?.captureResults ?? [];
  if (!savedEpisodeIds(results).length) return memory ? readTurnReceipt(application, [], { memory, agentName }) : null;
  try {
    const receipt = await readTurnReceipt(application, results, { memory, agentName });
    if (await application.taskContextRegistry.claimTurnReceipt(task.token, task.sourceApplication)) return receipt;
    // A later entry already showed these items; never repeat them.
    return memory ? readTurnReceipt(application, [], { memory, agentName }) : null;
  } catch {
    return deferredTurnReceipt();
  }
}

// What earlier turns of this session saved but never showed: read back, then
// claimed by this entry (a retry of the same entry gets the same receipts back).
// Nothing is claimed or said when it cannot be read; a later entry tries again.
export async function unreadTurnReceipt(application, task) {
  const unread = (task.unreadTurnReceipts ?? []).filter(item => savedEpisodeIds(item.capture_results).length);
  if (!unread.length) return null;
  const heading = '上轮沉淀（补发）';
  try {
    const receipt = await readTurnReceipt(application, unread.flatMap(item => item.capture_results), { heading });
    const claimed = new Set(await application.taskContextRegistry.claimUnreadTurnReceipts(task.token,
      unread.map(item => item.receipt_id), task.sourceApplication));
    if (claimed.size === unread.length) return receipt;
    // Another entry took some meanwhile: show only what this one claimed.
    const mine = unread.filter(item => claimed.has(item.receipt_id)).flatMap(item => item.capture_results);
    return mine.length ? await readTurnReceipt(application, mine, { heading }) : null;
  } catch {
    return null;
  }
}
