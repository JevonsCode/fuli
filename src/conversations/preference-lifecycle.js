import { compactTaskContext } from './task-context-view.js';
import { hookAdditionalContextToolResult } from '../mcp/tool-result.js';
import { SESSION_FULI_OFF } from '../agent-tools/session-fuli-gate.js';
import { withoutDeliveryProofs } from './recent-context.js';
import { copyPreferenceScope, taskPreferenceMetadata, withPreferenceScope } from './preference-snapshot.js';
import { joinTaskPreferencePages } from '../graphiti/task-preference-pages.js';
import { ALWAYS_INLINE_OMITTED_LABEL, fitUncached, inlineEntryFit, OMITTED_CONFLICTS_LABEL, OMITTED_PREFERENCES_LABEL,
  WHOLE_ENTRY } from './entry-inline-budget.js';
import { BLOCKED_PREFERENCE_LABEL } from '../mcp/preference-delivery.js';
import { taskReceiptInstruction } from '../agents/lifecycle-message.js';
import { skeletonFrameLabel } from './entry-skeleton.js';

export const PREFERENCE_RESET_EVENTS = Object.freeze(['SessionStart', 'PreCompact']);
const RESTORED_LABEL = 'Fuli restored current mandatory preferences for the same owned task. Apply this full result; no replacement task or Agent was selected.';
// The same restore bounded to the host's inline limit: what it leaves out is named in its own sentences.
const RESTORED_BOUNDED_LABEL = 'Fuli restored current mandatory preferences for the same owned task, bounded to this host\'s inline limit. Apply this result; no replacement task or Agent was selected.';

// `replayedSources`: the SessionStart sources after which the Agent's host
// replays the same native transcript into the model's context (Claude Code's
// resume, rec#11 D-69). The frames delivered before stay model-visible, so the
// context generation and its pending frames are kept and nothing is restored;
// a compaction the host records still starts a new generation.
// `inlineChars`: the host's inline limit, as for its task entry (preferenceHookOutput).
export async function preferenceLifecycleOutput(event, input, { sourceApplication, delivery, currentTask, invoke,
  replayedSources = [], inlineChars = null }) {
  if (typeof input?.session_id !== 'string' || !input.session_id.trim() || input.session_id.length > 256) {
    throw new TypeError('Preference reset requires a native session identifier');
  }
  if (event === 'SessionStart' && replayedSources.includes(input?.source)) return {};
  // A host's SessionStart "startup" is a session that has just begun.
  const origin = { sourceApplication, nativeSessionId: input?.session_id, transcriptPath: input?.transcript_path,
    sessionStarted: event === 'SessionStart' && input?.source === 'startup' };
  await delivery?.reset(origin);
  if (event !== 'SessionStart' || !['compact', 'resume', 'fork'].includes(input?.source)) return {};
  const refresh = await currentTaskPreferences(input, { sourceApplication, currentTask, invoke });
  if (refresh.status === 'other_session') throw new TypeError('Preference recovery requires the same owned native task');
  // No open task, or FULI was stopped for the session since its task began (rec#5 C3b): nothing to restore.
  if (refresh.status !== 'refreshed') return {};
  return preferenceHookOutput(refresh.context, event, input, delivery, sourceApplication, RESTORED_LABEL, true,
    { inlineChars, boundedLabel: RESTORED_BOUNDED_LABEL });
}

// A fresh read of the session's current task, in place: the same token, scope
// and Agent, never a new task or a switch. `status` says why nothing was read:
// no_task, task_closed, other_session, fuli_off, or refreshed with `context`.
export async function currentTaskPreferences(input, { sourceApplication, currentTask, invoke }) {
  const task = await currentTask?.(input.session_id, sourceApplication);
  if (!task) return { status: 'no_task' };
  if (task.checkpoint?.phase === 'complete') return { status: 'task_closed' };
  if (task.sessionId !== input.session_id || task.sourceApplication !== sourceApplication) return { status: 'other_session' };
  // The reader pages its uncompacted result at the MCP budget. The hook holds
  // those cursors in its own process, so it reads the whole revision and
  // compacts and bounds it itself: a first page alone is an incomplete frame
  // that blocks the turn and can never be confirmed (rec#76). Joined pages
  // carry the scope the reader gives an unpaged result: the task's own, in the
  // personal space the reader verified.
  const read = { taskContextToken: task.token, sourceApplication, sourceSessionId: input.session_id, sourceSessionVerified: true };
  let paged = false;
  const recovered = await joinTaskPreferencePages(cursor => {
    if (cursor) paged = true;
    return invoke('read_task_preferences', cursor ? { ...read, cursor } : read);
  });
  if (recovered?.status === SESSION_FULI_OFF) return { status: 'fuli_off' };
  const whole = paged ? withPreferenceScope(recovered, taskPreferenceMetadata(task, recovered.context?.personal_space_id))
    : recovered;
  return { status: 'refreshed', context: compactTaskContext(whole) };
}

// `inlineChars` is the inline limit of a host that keeps only a preview of a
// longer hook context (entry-inline-budget.js); without it the entry is whole.
// The model passes taskContextToken (PASS_TASK_TOKEN), so the hook context
// leaves out its snake_case copy; MCP results keep both (rec#11 D-72).
// `boundedLabel` replaces `label` for a frame that leaves something out. A
// blocked frame keeps the receipt sentence: its agent_receipt is still copied.
// The turn's prompt (null for a reset) lets a frame of the same task name an
// earlier frame's skeleton instead of repeating it (entry-skeleton.js).
export async function preferenceHookOutput(entry, event, input, delivery, sourceApplication, label, forceFull = false,
  { inlineChars = null, boundedLabel = label } = {}) {
  const { task_context_token: _copy, ...rest } = entry;
  const value = copyPreferenceScope(entry, rest);
  const frameLabel = projected => omittedLabel(label, boundedLabel, projected);
  const format = projected => hookAdditionalContextToolResult(projected, { hookEventName: event,
    label: skeletonFrameLabel(frameLabel(projected), projected), limitBytes: 128 * 1024, itemLimit: 1000,
    blockedLabel: `${BLOCKED_PREFERENCE_LABEL} ${taskReceiptInstruction(value)}`.trim() });
  const fit = inlineChars ? inlineEntryFit(inlineChars, hookContextLength) : WHOLE_ENTRY;
  const result = delivery ? await delivery.deliver(value, { sourceApplication,
    nativeSessionId: input.session_id, transcriptPath: input.transcript_path, forceFull,
    taskPrompt: typeof input.prompt === 'string' ? input.prompt : null, label: frameLabel }, format, fit)
    : fitUncached(fit, value, projected => format(withoutDeliveryProofs(projected)));
  return JSON.parse(result.content[0].text);
}

function omittedLabel(label, boundedLabel, projected) {
  const omitted = projected?.preferences_omitted, conflicts = projected?.active_conflicts_omitted;
  if (!omitted && !conflicts) return label;
  return [boundedLabel, ...(omitted ? [OMITTED_PREFERENCES_LABEL] : []),
    ...(omitted?.includes_always_inline ? [ALWAYS_INLINE_OMITTED_LABEL] : []), ...(conflicts ? [OMITTED_CONFLICTS_LABEL] : [])].join(' ');
}

function hookContextLength(result) {
  return JSON.parse(result.content[0].text).hookSpecificOutput.additionalContext.length;
}
