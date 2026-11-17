import { randomUUID } from 'node:crypto';

import { canonicalJson } from '../../packages/roundtable/src/canonical-json.js';
import { annotationsFor } from '../mcp/tool-annotations.js';
import { sha256Bytes } from '../security/digest.js';

// What a runner (docs/runner.md) answers for a call while its host is away,
// and what it keeps of the answers it got while the host was there. Task
// entry gets the last entry for that folder under a token of the runner's own;
// a checkpoint is queued; another read-only call gets the last answer to the
// same call. Everything else says the host must be reachable. Every offline
// answer says it is one, and when the answer it repeats was given.
export const OFFLINE_TOKEN_PREFIX = 'runner-offline-';
const TASK_ENTRY_TOOLS = new Set(['begin_task_context', 'get_collaboration_preferences']);
const QUEUED_TOOLS = new Set(['checkpoint_task_knowledge']);

// The tool a call runs and its input, through the chat profile's fuli_call too.
export function effectiveCall(name, args) {
  return name === 'fuli_call' && typeof args?.toolName === 'string'
    ? { tool: args.toolName, input: args.input ?? {} } : { tool: name, input: args ?? {} };
}

// Keeps an answer the host gave, for showing while it is away.
export function rememberAnswer(store, { tool, input }, result) {
  if (result?.isError) return;
  const key = answerKey(tool, input);
  if (key) store.rememberAnswer(key, tool, result);
}

export function offlineAnswer(store, { tool, input, sourceApplication, sessionId }) {
  if (TASK_ENTRY_TOOLS.has(tool)) {
    const token = `${OFFLINE_TOKEN_PREFIX}${randomUUID()}`;
    store.beginOfflineTask({ token, projectPath: input.projectPath ?? null, sourceApplication });
    const earlier = store.answer(answerKey(tool, input));
    const body = { ...(earlier ? resultValue(earlier.body) : { effective_preferences: [] }),
      taskContextToken: token, task_context_token: token };
    return envelope({ ...body, runner: offlineNote(earlier?.at,
      'Your FULI host is unreachable. These are the preferences it last gave for this folder; a checkpoint is queued and delivered when it answers again.') });
  }
  if (QUEUED_TOOLS.has(tool)) {
    const id = randomUUID();
    const token = typeof input.taskContextToken === 'string' ? input.taskContextToken : null;
    const offlineTask = token?.startsWith(OFFLINE_TOKEN_PREFIX) ? store.offlineTask(token) : null;
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
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'host_unreachable',
    message: 'Your FULI host is unreachable from this runner; this call needs it. Try again once both computers share a network.' }) }] };
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

function envelope(value) {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) };
}
