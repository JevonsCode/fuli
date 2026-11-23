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
// Continuing an earlier conversation: the host holds it, so what this computer
// can offer offline is the last recovery context it read for that conversation
// and the checkpoints it has not been able to deliver yet (rec#144).
const RESUME_TOOL = 'resume_agent_conversation';
// How many waiting checkpoints an offline resume carries over.
const RESUME_CHECKPOINTS = 3;
// How many waiting checkpoints are looked through for those of the same project.
const RESUME_SCAN = 200;
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

// A task entry the host answered, with where it was answered said plainly
// (rec#144: the Agent could not tell "the host is here" from "there is no
// FULI"). Only task entry carries it, and only when the host's answer is the
// JSON object every task entry is; anything else is passed through untouched.
export function hostAnsweredNote(tool, result, { hostName }) {
  if (!TASK_ENTRY_TOOLS.has(tool) || result?.isError) return result;
  const content = Array.isArray(result?.content) ? result.content : [];
  if (content.length > 1 || (content.length === 1 && content[0]?.type !== 'text')) return result;
  const value = resultValue(result);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.runner !== undefined) return result;
  const text = JSON.stringify({ ...value, runner: { offline: false, host: hostName,
    message: `This computer follows FULI on ${hostName}, which answered this entry; reads and checkpoints go there.` } });
  return { ...result, content: [{ type: 'text', text }], structuredContent: JSON.parse(text) };
}

// entryId: the id a checkpoint already carried online, whose outcome is unknown; it is queued under that id.
export function offlineAnswer(store, { tool, input, sourceApplication, sessionId, entryId = null }) {
  const host = store.host();
  if (!host || host.revokedAt) return notPaired(host);
  // Read here, not from the pairing check above: that check changes with other work on this file.
  const hostName = store.host()?.name ?? 'your FULI host';
  if (TASK_ENTRY_TOOLS.has(tool)) {
    const token = `${OFFLINE_TOKEN_PREFIX}${randomUUID()}`;
    store.beginOfflineTask({ token, projectPath: input.projectPath ?? null, sourceApplication });
    const earlier = store.answer(answerKey(tool, input));
    return envelope({ effective_preferences: [], ...folderEntry(earlier ? resultValue(earlier.body) : null),
      taskContextToken: token, task_context_token: token, checkpoint_required: false,
      checkpoint_guidance: OFFLINE_CHECKPOINT_GUIDANCE, runner: offlineNote(earlier?.at,
        `FULI is on ${hostName}, which this computer cannot reach right now. FULI is working: these are the preferences `
        + `${hostName} last gave for this folder, reads answer from what was kept here, and a checkpoint is queued and `
        + 'delivered when it answers again. Nothing needs to be moved or set up again; say that the host is away, not that '
        + 'FULI is missing.') });
  }
  if (QUEUED_TOOLS.has(tool)) {
    const id = entryId ?? randomUUID();
    const token = typeof input.taskContextToken === 'string' ? input.taskContextToken : null;
    const offlineTask = isOfflineToken(token) ? store.offlineTask(token) : null;
    store.enqueue({ id, tool, input, sourceApplication, sessionId, offlineProjectPath: offlineTask?.projectPath ?? null });
    return envelope({ status: 'queued_offline', outboxId: id, runner: offlineNote(null,
      'Your FULI host is unreachable. The checkpoint is queued on this computer and delivered when the host answers again.') });
  }
  if (tool === RESUME_TOOL) return resumeOffline(store, input, hostName);
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

// Continuing a conversation while the host is away (rec#144: 「主机每天带回家、
// runner 留在办公室接着干」). The host holds the conversation, so this computer
// offers what it has of it: the recovery context the host last gave for this
// very conversation, and the checkpoints still waiting here for the same
// project, which are the work done here since. Only what a recovery context
// holds is repeated (never the earlier task's receipt or duties), and work of
// another project or folder is never carried in. It says what it carried over
// and how old it is, and invents nothing: with neither, it says there is nothing.
function resumeOffline(store, input, hostName) {
  const conversationId = typeof input.conversationId === 'string' ? input.conversationId : '';
  const earlier = conversationId ? store.answer(answerKey(RESUME_TOOL, input)) : null;
  const folder = tokenFolder(store, input.taskContextToken);
  const waiting = folder === null ? [] : store.queuedCheckpoints(RESUME_SCAN)
    .filter((entry) => (entry.offlineProjectPath ?? tokenFolder(store, entry.input?.taskContextToken)) === folder)
    .slice(0, RESUME_CHECKPOINTS);
  const carried = { recovered_from_cache: Boolean(earlier), undelivered_checkpoints: waiting.length };
  if (!earlier && !waiting.length) {
    return failure('host_unreachable', `FULI is on ${hostName}, which this computer cannot reach right now, and nothing `
      + `of conversation ${conversationId || '(none named)'} is kept here: this computer never read it and has no `
      + 'checkpoint of this project waiting. Nothing is made up. Start from what the person says, or try again once the '
      + 'host answers.', { conversation_id: conversationId, ...carried });
  }
  const value = earlier ? resultValue(earlier.body) : null;
  return envelope({
    ...recoveryContext(value),
    conversation_id: conversationId,
    ...carried,
    undelivered_work: waiting.map((entry) => ({ queued_at: entry.queuedAt, summary: checkpointSummary(entry.input) })),
    runner: offlineNote(earlier?.at, `FULI is on ${hostName}, which this computer cannot reach right now, so this is not `
      + `the host's answer. ${earlier ? `It is the recovery context ${hostName} last gave for this conversation, read `
        + `${earlier.at}; anything said in it since is missing.` : 'Nothing of this conversation was read here.'}`
      + ` ${waiting.length ? `${waiting.length} checkpoint(s) of this project made here have not reached the host yet; `
        + 'their work logs are in undelivered_work.' : 'No checkpoint of this project is waiting here.'}`
      + ' Tell the person this context is from this computer\'s cache and may be out of date.')
  });
}

// What a recovery context holds (graph-provider conversation_context.py), and nothing of the task it was read in.
const RECOVERY_FIELDS = ['latest_checkpoint', 'messages', 'summary_role', 'truncated', 'compaction_summary', 'revision',
  'omitted_sequence', 'scan_truncated', 'guidance'];
function recoveryContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(RECOVERY_FIELDS.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]));
}

// The folder a task was entered for, from what this computer kept: a token it
// gave out offline, or one the host answered a task entry with. null: unknown.
function tokenFolder(store, token) {
  if (typeof token !== 'string' || !token) return null;
  if (isOfflineToken(token)) return store.offlineTask(token)?.projectPath ?? null;
  for (const { key, body } of store.taskEntries()) {
    const value = resultValue(body);
    if (value?.taskContextToken === token || value?.task_context_token === token) return entryFolder(key);
  }
  return null;
}

// The part of a queued checkpoint worth carrying over: what was done, kept short.
function checkpointSummary(input) {
  const log = typeof input?.workLog === 'string' ? input.workLog : '';
  return log.length > 1200 ? `${log.slice(0, 1200)}…` : log;
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
// checkpoint, which carries an entry id the host applies once; task entry,
// whose second task supersedes the first in that session (and which has its
// own offline answer); or resuming a conversation, which attaches the same
// conversation again with the same effect (and has its own offline answer, so
// a host that went away mid-session is not answered as an unknown outcome).
export function repeatable(tool) {
  return readOnly(tool) || QUEUED_TOOLS.has(tool) || TASK_ENTRY_TOOLS.has(tool) || tool === RESUME_TOOL;
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

// Task entry is kept per folder (its request differs every time); a resumed
// conversation per conversation, as its task token differs every time; other
// read-only calls per exact input. Calls that change something are not kept.
// The folder of a kept task entry, from its key (answerKey).
function entryFolder(key) {
  const match = /^entry:[^:]+:(.*)$/.exec(String(key ?? ''));
  return match && match[1] ? match[1] : null;
}

function answerKey(tool, input) {
  if (TASK_ENTRY_TOOLS.has(tool)) return `entry:${tool}:${input.projectPath ?? ''}`;
  if (tool === RESUME_TOOL) return typeof input?.conversationId === 'string' ? `resume:${input.conversationId}` : null;
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
