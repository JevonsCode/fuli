import { boundedHookMessage } from '../agents/lifecycle-message.js';

export const AUTO_CLOSE_SUMMARY = 'Auto-closed by the Stop hook: the Agent recorded no checkpoint for this task.';

// Called by every host's Stop hook. A task whose context came from the
// lifecycle hook is closed honestly as retain_nothing (status "reported", never
// "completed") instead of costing the model another full turn; any other open
// task keeps the advisory reminder. Nothing is invented or captured here.
export async function stopHookOutcome(check, invoke, source) {
  if (check?.decision !== 'block') return {};
  const remind = () => {
    const reason = boundedHookMessage(check?.reason);
    return reason.trim() ? { systemMessage: reason } : {};
  };
  if (check.entry_via !== 'hook' || typeof check.task_context_token !== 'string') return remind();
  try {
    await invoke('checkpoint_task_knowledge', {
      taskContextToken: check.task_context_token,
      disposition: 'retain_nothing',
      reason: AUTO_CLOSE_SUMMARY,
      workLog: { status: 'reported', summary: AUTO_CLOSE_SUMMARY },
      ...source
    });
    return {};
  } catch {
    return remind();
  }
}
