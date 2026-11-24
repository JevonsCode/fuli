import { boundedHookMessage } from '../agents/lifecycle-message.js';
import { citedKnowledge } from './reply-citations.js';
import { turnFindings } from './turn-findings.js';
import { turnTitle } from './turn-title.js';

export const AUTO_CLOSE_SUMMARY = 'Auto-closed by the Stop hook: the Agent recorded no checkpoint for this task.';

// Called by every host's Stop hook. A task whose context came from the
// lifecycle hook, or a routine fallback the Provider marks closable, is closed
// honestly as retain_nothing (status "reported", never "completed") instead of
// costing the model another full turn; any other open task keeps the advisory
// reminder. Nothing is invented here. reply: the turn's last answer, where the
// host gives it; what it cites is recorded as use. turn: the host adapter's
// reader of this turn's normalized records; from them come the pending
// experiences the close keeps (turn-findings.js, rec#88) and the work log's
// first line, which is the title a recovered conversation shows
// (turn-title.js, rec#146 item 4). Without records, or without anything in
// them, the close says so in the one honest sentence it always had.
export const AUTO_KEEP_REASON = 'Auto-closed by the Stop hook: the Agent recorded no checkpoint; FULI kept what the turn itself showed, pending review.';
export async function stopHookOutcome(check, invoke, source, { reply = null, turn = null } = {}) {
  if (check?.decision !== 'block') return {};
  const remind = () => {
    const reason = boundedHookMessage(check?.reason);
    return reason.trim() ? { systemMessage: reason } : {};
  };
  const closable = check.entry_via === 'hook' || check.routine_auto_close_eligible === true;
  if (!closable || typeof check.task_context_token !== 'string') return remind();
  const records = turnRecords(turn);
  // The Provider titles a task by the first line of its work summary, so the
  // line that says what the turn did comes first and the reason follows it.
  const title = turnTitle(records);
  const summary = experiences => {
    const note = experiences.length ? AUTO_KEEP_REASON : AUTO_CLOSE_SUMMARY;
    return title ? `${title}\n${note}` : note;
  };
  const close = (usage, experiences = []) => invoke('checkpoint_task_knowledge', {
    taskContextToken: check.task_context_token,
    disposition: experiences.length ? 'capture_candidates' : 'retain_nothing',
    reason: experiences.length ? AUTO_KEEP_REASON : AUTO_CLOSE_SUMMARY,
    workLog: { status: 'reported', summary: summary(experiences) },
    ...(usage.length ? { knowledgeUsage: usage } : {}),
    ...(experiences.length ? { experiences } : {}),
    ...source
  });
  const cited = citedKnowledge(reply);
  const found = turnFindings(records);
  // What the turn showed is offered first; a refused capture never keeps the task open.
  if (found.length) {
    try {
      await close(cited, found);
      return {};
    } catch { /* closed below without it */ }
  }
  try {
    await close(cited);
    return {};
  } catch {
    if (!cited.length) return remind();
  }
  // A link that names nothing usable never keeps the task open.
  try {
    await close([]);
    return {};
  } catch {
    return remind();
  }
}

// A host that gives no reader, or one that throws on an unreadable transcript,
// leaves the close with nothing to say about the turn, never without a close.
function turnRecords(turn) {
  try {
    const records = typeof turn === 'function' ? turn() : turn;
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}
