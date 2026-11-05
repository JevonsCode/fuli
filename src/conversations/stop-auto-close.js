import { boundedHookMessage } from '../agents/lifecycle-message.js';
import { citedKnowledge } from './reply-citations.js';

export const AUTO_CLOSE_SUMMARY = 'Auto-closed by the Stop hook: the Agent recorded no checkpoint for this task.';

// Called by every host's Stop hook. A task whose context came from the
// lifecycle hook, or a routine fallback the Provider marks closable, is closed
// honestly as retain_nothing (status "reported", never "completed") instead of
// costing the model another full turn; any other open task keeps the advisory
// reminder. Nothing is invented or captured here. reply: the turn's last answer,
// where the host gives it; what it cites is recorded as use.
export async function stopHookOutcome(check, invoke, source, { reply = null } = {}) {
  if (check?.decision !== 'block') return {};
  const remind = () => {
    const reason = boundedHookMessage(check?.reason);
    return reason.trim() ? { systemMessage: reason } : {};
  };
  const closable = check.entry_via === 'hook' || check.routine_auto_close_eligible === true;
  if (!closable || typeof check.task_context_token !== 'string') return remind();
  const close = (usage) => invoke('checkpoint_task_knowledge', {
    taskContextToken: check.task_context_token,
    disposition: 'retain_nothing',
    reason: AUTO_CLOSE_SUMMARY,
    workLog: { status: 'reported', summary: AUTO_CLOSE_SUMMARY },
    ...(usage.length ? { knowledgeUsage: usage } : {}),
    ...source
  });
  const cited = citedKnowledge(reply);
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
