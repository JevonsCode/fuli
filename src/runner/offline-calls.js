import { randomUUID } from 'node:crypto';

import { canonicalJson } from '../../packages/roundtable/src/canonical-json.js';
import { DIAGNOSTIC_EVENTS_TOOL, HOST_DIAGNOSTICS_ONLY } from '../diagnostics/agent-access.js';
import { annotationsFor } from '../mcp/tool-annotations.js';
import { sha256Bytes } from '../security/digest.js';

// What a runner (docs/runner.md) answers for a call while its host is away,
// and what it keeps of the answers it got while the host was there. Task
// entry gets the last entry for that folder under a token of the runner's own;
// a checkpoint is queued; another read-only call gets the last answer to the
// same call. Everything else says the host must be reachable. Every offline
// answer says it is one, and when the answer it repeats was given. An offline
// task entry repeats only the folder's preferences: what belonged to the
// earlier task (its token, receipt, checkpoint duty, recall) is not its own.
// A runner that is not paired, or whose host revoked it, answers nothing from cache.
const OFFLINE_TOKEN_PREFIX = 'runner-offline-';
const TASK_ENTRY_TOOLS = new Set(['begin_task_context', 'get_collaboration_preferences']);
export const QUEUED_TOOLS = new Set(['checkpoint_task_knowledge']);
// What an earlier task entry said about the folder rather than about its task.
const FOLDER_ENTRY_FIELDS = ['effective_preferences', 'active_conflicts', 'deferred_conflicts', 'context', 'project_scope'];
const OFFLINE_CHECKPOINT_GUIDANCE = 'Offline task: checkpoint only when there are capture candidates or a meaningful workLog. '
  + 'It is queued on this computer (status queued_offline) and saved only once the host answers again; '
  + 'never say it was saved before then. There is no agent_receipt for this task.';

export function isOfflineToken(value) {
  return typeof value === 'string' && value.startsWith(OFFLINE_TOKEN_PREFIX);
}

// The call's arguments without a runner's offline task token, for the host,
// which never knew it; through fuli_call the token is in its input.
export function withoutOfflineToken(name, args) {
  const strip = ({ taskContextToken: _token, ...rest }) => rest;
  return name === 'fuli_call' && typeof args?.toolName === 'string' ? { ...args, input: strip(args.input ?? {}) } : strip(args);
}

// The tool a call runs and its input, through the chat profile's fuli_call too.
export function effectiveCall(name, args) {
  return name === 'fuli_call' && typeof args?.toolName === 'string'
    ? { tool: args.toolName, input: args.input ?? {} } : { tool: name, input: args ?? {} };
}

// Enforce this on the runner as well as the host, including with an older host.
export function hostOnlyAnswer(tool) {
  return tool === DIAGNOSTIC_EVENTS_TOOL ? failure('local_user_only', HOST_DIAGNOSTICS_ONLY) : null;
}

// Keeps an answer the host gave, for showing while it is away.
export function rememberAnswer(store, { tool, input }, result) {
  if (result?.isError) return;
  const key = answerKey(tool, input);
  if (key) store.rememberAnswer(key, tool, result);
}

// entryId: the id a checkpoint already carried online, whose outcome is unknown; it is queued under that id.
export function offlineAnswer(store, { tool, input, sourceApplication, sessionId, entryId = null }) {
  const unpaired = unpairedAnswer(store);
  if (unpaired) return unpaired;
  if (TASK_ENTRY_TOOLS.has(tool)) {
    const token = `${OFFLINE_TOKEN_PREFIX}${randomUUID()}`;
    store.beginOfflineTask({ token, projectPath: input.projectPath ?? null, sourceApplication });
    const earlier = store.answer(answerKey(tool, input));
    return envelope({ effective_preferences: [], ...folderEntry(earlier ? resultValue(earlier.body) : null),
      taskContextToken: token, task_context_token: token, checkpoint_required: false,
      checkpoint_guidance: OFFLINE_CHECKPOINT_GUIDANCE, runner: offlineNote(earlier?.at,
        'Your FULI host is unreachable. These are the preferences it last gave for this folder; a checkpoint is queued and delivered when it answers again.') });
  }
  if (QUEUED_TOOLS.has(tool)) {
    const id = entryId ?? randomUUID();
    const token = typeof input.taskContextToken === 'string' ? input.taskContextToken : null;
    const offlineTask = isOfflineToken(token) ? store.offlineTask(token) : null;
    store.enqueue({ id, tool, input, sourceApplication, sessionId, offlineProjectPath: offlineTask?.projectPath ?? null });
    return envelope({ status: 'queued_offline', outboxId: id, runner: offlineNote(null,
      'Your FULI host is unreachable. The checkpoint is queued on this computer and delivered when the host answers again.') });
  }
  const earlier = readOnly(tool) ? store.answer(answerKey(tool, input)) : null;
  if (earlier) {
    const value = resultValue(earlier.body);
    return envelope(value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value, runner: offlineNote(earlier.at, 'Your FULI host is unreachable; this is its earlier answer.') }
      : { answer: value, runner: offlineNote(earlier.at, 'Your FULI host is unreachable; this is its earlier answer.') });
  }
  return failure('host_unreachable',
    'Your FULI host is unreachable from this runner; this call needs it. Try again once both computers share a network.');
}

// The pairing every call needs: null while this computer is paired, else the
// refusal. A judgment made here needs it too (local-routing.js): its decision
// is the host's to keep, and nothing of this runner's own survives a revoke.
export function unpairedAnswer(store) {
  const host = store.host();
  return !host || host.revokedAt ? notPaired(host) : null;
}

// No pairing, or the host said it does not know this runner (revoked): nothing kept is shown.
function notPaired(host) {
  return host?.revokedAt
    ? failure('runner_revoked', 'This computer\'s pairing was revoked on its FULI host or is not known there. '
      + 'Nothing is kept here any more. To use FULI again, run `fuli runner invite` on the host and `fuli runner join` here.')
    : failure('runner_not_paired', 'This computer is not paired with a FULI host. '
      + 'Run `fuli runner invite` on the host and `fuli runner join` here.');
}

// details: what else the caller needs to act on the failure, beside code and message.
export function failure(code, message, details = {}) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message, ...details }) }] };
}

// Whether a call may be made again after its connection dropped: a read; a
// checkpoint, which carries an entry id the host applies once; or task entry,
// whose second task supersedes the first in that session (and which has its
// own offline answer).
export function repeatable(tool) {
  return readOnly(tool) || QUEUED_TOOLS.has(tool) || TASK_ENTRY_TOOLS.has(tool);
}

// A call that changes something, sent before the connection to the host
// dropped: it may or may not have run there, and it is not made again.
export function outcomeUnknownAnswer(tool) {
  return failure('outcome_unknown', `The connection to your FULI host dropped while ${tool} was running; it may or may not `
    + 'have been applied there, and it was not sent again. Check with a read before you repeat it.');
}

// The host answered but refused a new MCP session (its session limit, a
// failure on its side): said as it is, never as the host being away.
// The host's own reason says what to do: it is the only side that knows whose
// sessions are open, so this never guesses that they are this computer's.
export function hostRefusedAnswer(status, reason) {
  return failure('host_refused', `Your FULI host answered but refused a new MCP session (HTTP ${status}: ${reason}). `
    + 'Nothing was sent.');
}

// A call that needs a task the host entered, made with this computer's
// offline token while the host answers again: the task is entered again first.
export function offlineTaskAnswer(tool) {
  return failure('offline_task_token', `${tool} needs a task your FULI host entered, and this task was entered on this `
    + 'computer while the host was away (a runner-offline- token the host never knew). The host answers again: enter the '
    + `task again with get_collaboration_preferences, then call ${tool} with its taskContextToken.`);
}

// A queued checkpoint the host has now applied.
export function deliveredAnswer(outboxId) {
  return envelope({ status: 'delivered', outboxId, runner: { offline: false,
    message: 'The host answered again; this checkpoint was delivered to it and saved.' } });
}

// The preferences the host last gave a task entry in this project, from any
// of its folders, for Tonborg's judgment on this runner (local-routing.js):
// { answeredAt, effective_preferences, active_conflicts } or null.
export function projectPreferences(store, { personalSpaceId, personalProjectId }) {
  for (const { at, body } of store.taskEntries()) {
    const value = resultValue(body);
    const context = value?.context;
    if (context?.personal_space_id !== personalSpaceId || context?.personal_project_id !== personalProjectId) continue;
    return { answeredAt: at, effective_preferences: value.effective_preferences ?? [],
      active_conflicts: value.active_conflicts ?? [] };
  }
  return null;
}

function folderEntry(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(FOLDER_ENTRY_FIELDS.filter((field) => value[field] !== undefined)
    .map((field) => [field, value[field]]));
}

// Task entry is kept per folder (its request differs every time); other
// read-only calls per exact input. Calls that change something are not kept.
function answerKey(tool, input) {
  if (TASK_ENTRY_TOOLS.has(tool)) return `entry:${tool}:${input.projectPath ?? ''}`;
  if (!readOnly(tool)) return null;
  return `read:${tool}:${sha256Bytes(Buffer.from(canonicalJson(input ?? {})))}`;
}

// A tool this version does not know (the host may be newer) is not kept.
function readOnly(tool) {
  try { return annotationsFor(tool).readOnlyHint; } catch { return false; }
}

function resultValue(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  try { return JSON.parse(result?.content?.find((item) => item.type === 'text')?.text ?? 'null'); } catch { return null; }
}

function offlineNote(at, message) {
  return { offline: true, ...(at ? { answeredAt: at } : {}), message };
}

export function envelope(value) {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) };
}
