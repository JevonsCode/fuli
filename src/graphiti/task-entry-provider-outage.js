import { isProviderOutage } from './provider-outage.js';

// rec#105: preferences live in the Graph Provider, so while it does not answer
// the entry cannot deliver them. The Agent gets a bounded status that says so
// and what to do next, instead of a bare error that drops the whole task entry.
const GUIDANCE = 'FULI could not read preferences because its graph service did not answer. ' +
  'No task token or receipt was returned. Continue the user task without FULI preferences; never invent them or reuse an earlier token. ' +
  'Call get_collaboration_preferences once more before any FULI write or your final reply; if it fails again, say in one line that FULI was unavailable.';

export function preferencesUnavailableEntry(error) {
  return {
    status: 'preferences_unavailable',
    reason: error.code,
    checkpoint_required: false,
    preference_delivery: { status: 'unavailable' },
    task_lifecycle: { status: 'not_started', reason: 'provider_unavailable' },
    task_knowledge_recall: { status: 'unavailable' },
    retry: { tool: 'get_collaboration_preferences', attempts: 1 },
    guidance: GUIDANCE
  };
}

export async function withProviderOutageEntry(entry) {
  try {
    return await entry;
  } catch (error) {
    if (isProviderOutage(error)) return preferencesUnavailableEntry(error);
    throw error;
  }
}
