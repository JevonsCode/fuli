import { deferredTurnReceipt, MAX_LIST_EPISODES, readEpisodeReceipts, readTurnReceipt, renderTurnReceipt, savedEpisodeIds }
  from '../agents/turn-receipt.js';
import { withReceiptLines, withTurnReceipt } from '../agents/identity-receipt.js';
import { taskKnowledgeReader } from './knowledge-reader.js';
import { formalTask, sessionMigrationLine, sessionMigrationOffer } from './session-knowledge-migration.js';
import { receiptFormatNotices } from '../data-format/format-notices.js';

// When a turn's receipt reaches a reply, exactly once (rec#20). The Provider
// marks a checkpoint that saved knowledge as unread. Its own reply claims it
// after reading it back; a retry of that checkpoint claims it again and shows
// the same lines. When the reply could not carry it (reading back or claiming
// failed, or the call failed after saving) it stays unread. The session's next
// task entry reads it back first and claims it only then, so one that cannot be
// read yet stays unread for a later entry; it is shown once, marked as late.

// The receipt of a completed checkpoint, or null when it saved nothing new
// and no migration waits. memory: the Agent working-memory write this
// checkpoint made, if any. The checkpoint's receipt replaces the entry's, so
// the session's migration link is worked out again here (dot P2-2): this
// turn left items undecided in a formal project, or it is still the session's
// first task there while items wait.
export async function checkpointTurnReceipt(application, task, { memory = null, agentName = null } = {}) {
  const results = task.checkpoint?.captureResults ?? [];
  const receipt = await savedTurnReceipt(application, task, results, { memory, agentName });
  const migration = receipt && heldInFormalProject(task, results) ? sessionMigrationLine(application, task)
    : await sessionMigrationOffer(application, task);
  if (!migration) return receipt;
  return receipt ? { ...receipt, lines: [...receipt.lines, migration] } : { lines: [migration] };
}

async function savedTurnReceipt(application, task, results, { memory, agentName }) {
  if (!savedEpisodeIds(results).length) return memory ? readTurnReceipt(application, [], { memory, agentName }) : null;
  try {
    const receipt = await readTurnReceipt(application, results, { memory, agentName, session: taskSession(task),
      reader: taskKnowledgeReader(task) });
    if (await application.taskContextRegistry.claimTurnReceipt(task.token, task.sourceApplication)) return receipt;
    // A later entry already showed these items; never repeat them.
    return memory ? readTurnReceipt(application, [], { memory, agentName }) : null;
  } catch {
    return deferredTurnReceipt();
  }
}

// A task entry's receipt: the identity line, then what earlier turns saved but
// never showed, then the offer to migrate what the session's temporary project
// holds once the session linked to a formal project (rec#20 part 2).
export async function entryAgentReceipt(application, task, receipt) {
  const format = await receiptFormatNotices(application, { taskId: task.token, includePending: false });
  if (format.length) receipt = { ...receipt, markdown: [receipt.markdown, ...format].join(' · ') };
  const late = await unreadTurnReceipt(application, task);
  const migration = await sessionMigrationOffer(application, task);
  return withReceiptLines(withTurnReceipt(receipt, late), migration ? [migration] : []);
}

// What earlier turns of this session saved but never showed. Each receipt is
// read back first; only then are they claimed by this entry, and the lines are
// made from what was already read for the receipts this entry won. No read can
// fail after a claim. A retry of the same entry gets the same receipts back.
// Nothing is claimed or said when a read fails; a later entry tries again. A
// long backlog goes in batches small enough for one full-list link; the rest
// stays unread for the next entry.
async function unreadTurnReceipt(application, task) {
  const unread = lateBatch((task.unreadTurnReceipts ?? []).filter(item => savedEpisodeIds(item.capture_results).length));
  if (!unread.length) return null;
  try {
    const read = [];
    for (const item of unread) {
      read.push({ item, entries: (await readEpisodeReceipts(application, savedEpisodeIds(item.capture_results),
        { reader: taskKnowledgeReader(task) })).entries });
    }
    const claimed = new Set(await application.taskContextRegistry.claimUnreadTurnReceipts(task.token,
      unread.map(item => item.receipt_id), task.sourceApplication));
    const mine = read.filter(({ item }) => claimed.has(item.receipt_id));
    if (!mine.length) return null;
    return renderTurnReceipt(application, mine.flatMap(({ entries }) => entries), { heading: '上轮沉淀（补发）',
      episodeIds: mine.flatMap(({ item }) => savedEpisodeIds(item.capture_results)), session: taskSession(task) });
  } catch {
    return null;
  }
}

// rec#20 part 2: this turn worked in a formal project yet left items in the
// session's temporary project; its receipt links the person to the migration.
function heldInFormalProject(task, results) {
  return formalTask(task) && results.some(result => result.scope === 'session_temporary'
    && savedEpisodeIds([result]).length);
}

// The host session a receipt links to: every turn of a late receipt is of
// the entry's own session.
function taskSession(task) {
  return { sourceApplication: task.sourceApplication, sessionId: task.sessionId };
}

// The oldest receipts whose episodes fit one full-list link.
function lateBatch(unread) {
  const batch = [];
  let episodes = 0;
  for (const item of unread) {
    const count = savedEpisodeIds(item.capture_results).length;
    if (episodes + count > MAX_LIST_EPISODES) break;
    batch.push(item);
    episodes += count;
  }
  return batch;
}
