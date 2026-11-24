import { deferredTurnReceipt, MAX_LIST_EPISODES, readEpisodeReceipts, readTurnReceipt, renderTurnReceipt, savedEpisodeIds }
  from '../agents/turn-receipt.js';
import { receiptConsoleUrl, withReceiptLines, withTurnReceipt } from '../agents/identity-receipt.js';
import { TASK_KEY_PREFIX_LENGTH, taskKeyFor } from '../knowledge-impressions/store.js';
import { markdownLink } from '../text/markdown-link.js';
import { taskKnowledgeReader } from './knowledge-reader.js';
import { formalTask, sessionMigrationLine, sessionMigrationNotice, sessionMigrationOffer } from './session-knowledge-migration.js';
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
  const lines = [migration, storedHabitsLine(application, task)].filter(Boolean);
  if (!lines.length) return receipt;
  return receipt ? { ...receipt, lines: [...receipt.lines, ...lines] } : { lines };
}

// The first reply of a new conversation says how many of the person's habits
// FULI put into that entry, and links the list. 准备 (made ready), never 用了:
// FULI sees what it handed over, not what the AI applied — and what the host's
// inline limit then left out is not in the conversation at all, so the line
// never calls the whole set carried (rec#146 item 6). The entry frame replaces
// this sentence with the split it can see once the fit has run
// (entry-habits-line.js); here, off the entry path, only the resolved count is
// known. delivery: { taskKey, count } of an entry that opened a conversation.
function habitsLine(application, delivery) {
  if (!(delivery?.count >= 1)) return null;
  return `${HABITS_LEAD}${preparedHabits(delivery.count)} · `
    + markdownLink('看看是哪几条', `${receiptConsoleUrl(application)}/habits/${delivery.taskKey.slice(0, TASK_KEY_PREFIX_LENGTH)}`);
}

// Whether this task's entry opened its conversation, from the row the entry
// wrote (knowledge-impressions); null when there is no row or it cannot be read.
export function entryOpenedConversation(application, task) {
  try {
    const row = application.recallImpressions?.delivery(taskKeyFor(task.token).slice(0, TASK_KEY_PREFIX_LENGTH));
    return row ? Boolean(row.opensConversation) : null;
  } catch {
    return null;
  }
}

// The lead that marks a habits line, and the sentence that follows it. Both are
// shared with the entry frame's rewrite, so the two can never drift apart.
// One language, like every other receipt line (the console has no per-person
// language setting the receipt could follow): a bilingual line doubled its
// length and read "1 habits" (review of #1070).
export const HABITS_LEAD = 'FULI 习惯：';
export const preparedHabits = count => `这个新对话为你准备了 ${count} 条习惯`;

// The same sentence once the entry knows what its host's inline limit left
// room for: what the assistant has in front of it, and what it can read when a
// task may touch it (rec#146 item 6). Their sum is every preference the entry
// resolved; a later receipt counts its stored row (ids once, at most 100), so
// it is the same number unless ids are missing, shared or over the cap.
// `unneeded`: those of the readable ones left out because this task is not the
// case they state (preference-conditions.js), so a habit that did not come
// along is never read as one crowded out.
export const deliveredHabits = (inline, readable, unneeded = 0) =>
  `这个新对话为你准备了 ${inline + readable} 条习惯：直接带上 ${inline} 条，另外 ${readable} 条随时可读`
  + (unneeded ? `（${unneeded} 条这次用不上）` : '');

// A checkpoint, roundtable or pause receipt replaces the entry's, so a task
// whose entry opened the conversation says it again from its stored row: one
// local primary-key read, off the entry path. Any other task, or a failing
// read, says nothing.
export function storedHabitsLine(application, task) {
  try {
    const row = application.recallImpressions?.delivery(taskKeyFor(task.token).slice(0, TASK_KEY_PREFIX_LENGTH));
    return row?.opensConversation ? habitsLine(application, { taskKey: row.taskKey, count: row.preferenceKeys.length }) : null;
  } catch {
    return null;
  }
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
// holds once the session linked to a formal project (rec#20 part 2), and
// what a person confirmed moving for this session since its last entry (rec#82),
// and, when this entry opened a new conversation, the habits it handed over
// (habits: { taskKey, count } from the delivery record, or null).
export async function entryAgentReceipt(application, task, receipt, habits = null) {
  const format = await receiptFormatNotices(application, { taskId: task.token, includePending: false });
  if (format.length) receipt = { ...receipt, markdown: [receipt.markdown, ...format].join(' · ') };
  const late = await unreadTurnReceipt(application, task);
  const confirmed = sessionMigrationNotice(application, task);
  const migration = await sessionMigrationOffer(application, task);
  return withReceiptLines(withTurnReceipt(receipt, late),
    [confirmed, migration, habitsLine(application, habits)].filter(Boolean));
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
