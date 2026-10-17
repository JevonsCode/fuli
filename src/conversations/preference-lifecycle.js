import { compactTaskContext } from './task-context-view.js';
import { hookAdditionalContextToolResult } from '../mcp/tool-result.js';

export const PREFERENCE_RESET_EVENTS = Object.freeze(['SessionStart', 'PreCompact']);

export async function preferenceLifecycleOutput(event, input, { sourceApplication, delivery, currentTask, invoke }) {
  if (typeof input?.session_id !== 'string' || !input.session_id.trim() || input.session_id.length > 256) {
    throw new TypeError('Preference reset requires a native session identifier');
  }
  const origin = { sourceApplication, nativeSessionId: input?.session_id, transcriptPath: input?.transcript_path };
  await delivery?.reset(origin);
  if (event !== 'SessionStart' || !['compact', 'resume', 'fork'].includes(input?.source)) return {};
  const task = await currentTask?.(input.session_id, sourceApplication);
  if (!task || task.checkpoint?.phase === 'complete') return {};
  if (task.sessionId !== input.session_id || task.sourceApplication !== sourceApplication) {
    throw new TypeError('Preference recovery requires the same owned native task');
  }
  const recovered = await invoke('read_task_preferences', {
    taskContextToken: task.token, sourceApplication, sourceSessionId: input.session_id, sourceSessionVerified: true
  });
  return preferenceHookOutput(compactTaskContext(recovered), event, input, delivery, sourceApplication,
    'Fuli restored current mandatory preferences for the same owned task. Apply this full result; no replacement task or Agent was selected.', true);
}

export async function preferenceHookOutput(value, event, input, delivery, sourceApplication, label, forceFull = false) {
  const format = projected => hookAdditionalContextToolResult(projected, {
    hookEventName: event, label, limitBytes: 128 * 1024, itemLimit: 1000
  });
  const result = delivery ? await delivery.deliver(value, { sourceApplication,
    nativeSessionId: input.session_id, transcriptPath: input.transcript_path, forceFull }, format) : format(value);
  return JSON.parse(result.content[0].text);
}
