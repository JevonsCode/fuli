import { deferredTurnReceipt, readTurnReceipt, savedEpisodeIds } from '../agents/turn-receipt.js';

// When a turn's receipt reaches a reply, exactly once (rec#20). The Provider
// marks a checkpoint that saved knowledge as unread. Its own reply claims it
// after reading it back; a retry of that checkpoint claims it again and shows
// the same lines. When the reply could not carry it (reading back or claiming
// failed, or the call failed after saving) it stays unread, and the session's
// next task entry claims it and shows it once, marked as a late delivery.

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

// What earlier turns of this session saved but never showed, claimed by this
// entry (a retry of the same entry gets the same receipts back).
export async function unreadTurnReceipt(application, unread) {
  const results = (unread ?? []).flatMap(item => item.capture_results ?? []);
  if (!savedEpisodeIds(results).length) return null;
  try {
    return await readTurnReceipt(application, results, { heading: '上轮沉淀（补发）' });
  } catch {
    return { lines: ['FULI 上轮沉淀（补发）：回执读取失败，可在控制台知识页查看'], summary: { status: 'unreadable' } };
  }
}
