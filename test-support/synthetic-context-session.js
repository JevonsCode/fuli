// Synthetic stand-ins for one native client session and the Provider's
// conversation journal (rec#15). Shared by the recent-context and scene
// delivery tests and by acceptance/context-delivery-replay. Every transcript,
// message and preference made here is synthetic; no client runs.
import { createHash } from 'node:crypto';
import { appendFile, copyFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const sha = text => createHash('sha256').update(text).digest('hex');

// A synthetic host: its native transcript, written the way each client records
// native messages, a tool result or a delivered hook context. `inject` returns
// the record's offset; a Claude attachment's uuid is `attachment-<offset>`.
export function syntheticHost(directory, client, sessionId, { fileName = `${client}-${sessionId}.jsonl` } = {}) {
  const path = join(directory, fileName);
  let size = 0;
  const write = async record => {
    const line = `${JSON.stringify(record)}\n`;
    const offset = size;
    await appendFile(path, line);
    size += Buffer.byteLength(line);
    return offset;
  };
  const codex = client === 'codex';
  return {
    client, sessionId, path,
    start: () => write(codex ? { type: 'session_meta', payload: { id: sessionId } }
      : { type: 'system', subtype: 'init', sessionId }),
    // The stored event ID names the native record, as the transcript collector does.
    say: async (role, text) => `jsonl-v1:${await write(codex
      ? { type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } }
      : { type: role, sessionId, message: { role, content: role === 'user' ? text : [{ type: 'text', text }] } })}:0:0`,
    inject: text => write(codex
      ? { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ['hooks.additional_context'],
          content_item_metadata: [{ provenance: { type: 'harness', hook: true } }] } } }
      : { type: 'attachment', sessionId, uuid: `attachment-${size}`,
        attachment: { type: 'hook_additional_context', hookEvent: 'UserPromptSubmit' }, rendered: [{ content: text }] }),
    compact: () => write(codex ? { type: 'compacted', payload: { window_id: 'next' } }
      : { type: 'system', subtype: 'compact_boundary', sessionId }),
    // A FULI tool result whose structured copy and visible text may differ.
    toolResult: async (id, structured, visible, name = 'mcp__fuli__begin_task_context', input = {}) => {
      const output = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(visible) }], structuredContent: structured });
      await write(codex ? { type: 'response_item', payload: { type: 'function_call', name, call_id: id, arguments: JSON.stringify(input) } }
        : { type: 'assistant', sessionId, message: { content: [{ type: 'tool_use', id, name, input }] } });
      await write(codex ? { type: 'response_item', payload: { type: 'function_call_output', call_id: id, output } }
        : { type: 'user', sessionId, message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] } });
    },
    // Rewrites the same file in place (same identity) with only its header
    // and, optionally, one message at the next offset.
    rewriteInPlace: async (text = null) => {
      size = 0;
      await writeFile(path, '');
      await write(codex ? { type: 'session_meta', payload: { id: sessionId } } : { type: 'system', subtype: 'init', sessionId });
      if (text !== null) await write(codex
        ? { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
        : { type: 'user', sessionId, message: { role: 'user', content: text } });
    },
    replace: async () => {
      // The same bytes under a new file identity.
      const copy = `${path}.copy`;
      await copyFile(path, copy);
      await rm(path);
      await rename(copy, path);
    }
  };
}

// The Provider's own recovery window (graph-provider store_agent_conversations.py
// _context_events, conversation_context.py pack_context): read back to the third
// visible user message, then keep the newest messages whose packed JSON fits the
// conversation policy's context_budget (default 4000 bytes), a lone newest one as
// a prefix. A journal made with it answers as the Provider would.
export const PROVIDER_RECOVERY_WINDOW = Object.freeze({ userMessages: 3, budgetBytes: 4000 });

// A synthetic Provider journal shared by both clients, with the proofs
// add_delivery_proofs attaches for the asking session. Without `window` it
// returns every event, as the unit tests that pick their own window expect.
export function syntheticJournal(conversationId = 'conversation-a', window = null) {
  const events = [];
  const proofs = (client, sessionId, current) => message => {
    const event = events[message.sequence - 1];
    return { ...message, content_sha256: sha(current(event)),
      ...(event.source_application === client && event.session_id === sessionId ? { own_event: event.event_id } : {}) };
  };
  return {
    events,
    add: (role, content, client, sessionId, eventId) => events.push({ sequence: events.length + 1, role, content,
      source_application: client, session_id: sessionId, event_id: eventId }),
    recovery: (client, sessionId, { window: count = events.length, truncate = null, override = {} } = {}) => {
      const current = event => override[event.sequence] ?? event.content;
      if (window) {
        const packed = providerRecovery(events.map(event => ({ ...event, content: current(event) })), window,
          { conversation_id: conversationId, revision: events.length });
        return { ...packed, messages: packed.messages.map(proofs(client, sessionId, current)) };
      }
      return { conversation_id: conversationId, revision: events.length, summary: '', summary_role: 'historical', truncated: false,
        latest_checkpoint: null, omitted_sequence: null, scan_truncated: false,
        messages: events.slice(-count).map(event => {
          const content = current(event);
          const shown = truncate === event.sequence ? { content: `${content.slice(0, 8)}…`, truncated: true } : { content };
          return proofs(client, sessionId, current)({ sequence: event.sequence, role: event.role, ...shown });
        }) };
    }
  };
}

// pack_context over the events _context_events returns; bytes as json_bytes
// (compact separators, UTF-8), measured before the host-only proofs.
function providerRecovery(events, { userMessages, budgetBytes }, identity) {
  let start = events.length, users = 0;
  while (start > 0 && users < userMessages) users += events[--start].role === 'user';
  const scanned = events.slice(start);
  const result = { summary: '', messages: [], truncated: start > 0, summary_role: 'historical', latest_checkpoint: null,
    ...identity, omitted_sequence: start > 0 ? events[start].sequence - 1 : null, scan_truncated: false };
  const fits = () => Buffer.byteLength(JSON.stringify(result), 'utf8') <= budgetBytes;
  if (!fits()) {
    if (scanned.length) result.omitted_sequence = scanned.at(-1).sequence;
    return result;
  }
  for (const event of [...scanned].reverse()) {
    result.messages.unshift({ sequence: event.sequence, role: event.role, content: event.content });
    if (fits()) continue;
    result.messages.shift();
    result.truncated = true;
    result.omitted_sequence = event.sequence;
    while (result.messages.length && !fits()) result.omitted_sequence = result.messages.shift().sequence;
    if (!result.messages.length) {
      const newest = scanned.at(-1);
      result.omitted_sequence = newest.sequence;
      const item = { sequence: newest.sequence, role: newest.role, content: '', truncated: true };
      result.messages.push(item);
      if (fits()) fitPrefix([...newest.content], item, fits);
      else result.messages.length = 0;
    }
    break;
  }
  return result;
}

// _fit_prefix: the longest code-point prefix plus … whose whole JSON fits.
function fitPrefix(points, item, fits) {
  let low = 0, high = points.length, best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    item.content = `${points.slice(0, middle).join('')}…`;
    if (fits()) { best = item.content; low = middle + 1; } else high = middle - 1;
  }
  item.content = best;
}

// A confirmed Provider preference item as collaboration_context returns it.
export const syntheticPreference = (key, instruction, qualifiers = {}, aspect = 'taste') => ({ id: `item-${key}`,
  item_kind: 'entity', preference_key: key, preference_scope: 'global', profile_aspect: aspect,
  confirmation_status: 'confirmed', instruction, preference_qualifiers: qualifiers });

// What the model holds after each frame, following only the delivery rules:
// a delta or scene switch applies to the one earlier frame of the context
// generation (`views`, by revision) whose revision equals its base_revision or
// supersedes. Without exactly one such set the model has no base and would
// call read_task_preferences: the result is null, never a guess.
export function replayPreferences(views, frame) {
  const delivery = ['delta', 'scene_switch'].includes(frame.preference_delivery?.status) ? frame.preference_delivery : null;
  const base = delivery ? views.get(delivery.status === 'delta' ? delivery.base_revision : delivery.supersedes) : new Map();
  if (!base) return null;
  const key = item => item.preference_key;
  const next = new Map(base);
  if (delivery?.status === 'scene_switch') for (const replaced of delivery.replaces) next.delete(replaced);
  if (delivery?.status === 'delta') for (const removed of delivery.removed) next.delete(key(removed));
  for (const item of frame.effective_preferences ?? frame.preference_updates) next.set(key(item), item.instruction);
  const revision = delivery?.revision ?? frame.revision;
  const same = held => held && JSON.stringify([...held].sort()) === JSON.stringify([...next].sort());
  if (revision) views.set(revision, views.has(revision) && !same(views.get(revision)) ? null : next);
  return next;
}
