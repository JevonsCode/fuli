import { createHash } from 'node:crypto';

export const taskContextHash = token => createHash('sha256').update(token).digest('hex');

export async function observeReturnedMemory(app, store, { ask, reply, from, taskContextToken }) {
  ask = store.getMessage(ask.id) ?? ask;
  const target = ask.target_project_id;
  const resultCount = Number(ask.memory_result_count ?? 0);
  if (!target || !from.projectId || target === from.projectId || !reply?.body.trim()
      || ask.from_agent !== from.agent?.agentId || !Number.isSafeInteger(resultCount) || resultCount <= 0) return null;
  if (ask.memory_usage_recorded === '1') return { recorded: true };
  if (!taskContextToken || ask.source_context_hash !== taskContextHash(taskContextToken)) {
    return { recorded: false, reason: 'original_task_context_required' };
  }
  if (!app.personal.recordProjectMemoryUsage) return { recorded: false, reason: 'usage_port_unavailable' };
  try {
    const result = await app.personal.recordProjectMemoryUsage({ personal_space_id: app.config.personal.spaceId,
      task_context_token: taskContextToken, source_application: from.client,
      target_project_id: target, channel: 'roundtable_answer', evidence_id: reply.id, result_count: resultCount });
    if (result.recorded) store.markMemoryObserved(ask.id);
    return result;
  } catch (error) {
    return { recorded: false, reason: error.code ?? 'observation_failed' };
  }
}
