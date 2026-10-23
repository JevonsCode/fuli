import { isDeepStrictEqual } from 'node:util';
import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { transcriptDigest } from './transcript-guard.js';
import { transcriptRecordEvents } from './transcript-reader.js';

// Incremental recent context for one native session (rec#15 PR2, D-27). A
// recovered message is left out only when this session's context generation
// provably holds that exact version: its own native record, or a complete
// injected frame the host recorded. Everything else is delivered, within the
// Provider's budget. The cache holds only sequences and hashes.
const PROOF_FIELDS = ['content_sha256', 'own_event'];
const OWN_EVENT = /^jsonl-v1:(\d+):(\d+):(\d+)$/;
const HASH = /^[a-f0-9]{64}$/;
export const MAX_RECENT_FRAMES = 8;
const MAX_FRAME_ITEMS = 32;
const WITHDRAWN_GUIDANCE = 'Earlier delivered versions of these message sequences are replaced; use only the versions here.';
const NO_EVIDENCE = Object.freeze({ frames: Object.freeze([]), native: () => false });

// The Provider's proofs are for the host; the model never receives them.
export function withoutDeliveryProofs(value) {
  const recovery = value?.conversation?.recovery;
  if (!Array.isArray(recovery?.messages) || !recovery.messages.some(hasProofs)) return value;
  return { ...value, conversation: { ...value.conversation,
    recovery: { ...recovery, messages: recovery.messages.map(withoutProofs) } } };
}

// Native byte offsets of this session's own recovered messages.
export function ownRecordOffsets(value) {
  const messages = value?.conversation?.recovery?.messages;
  return new Set((Array.isArray(messages) ? messages : [])
    .map(message => OWN_EVENT.exec(message?.own_event ?? '')?.[1]).filter(Boolean).map(Number));
}

// Seen from the session's own transcript: the stored event names a complete
// native record of this generation, whose same event (role, kind and content
// chunk) hashes to the stored full content. A replaced file, a reused offset
// or another record never matches; a mismatch is unknown, never a withdrawal.
function nativeMessageProof(proof, { sessionId, adapter, floor }) {
  if (!proof.known || typeof adapter?.normalize !== 'function') return NO_EVIDENCE.native;
  return message => {
    const offset = Number(OWN_EVENT.exec(message.own_event ?? '')?.[1] ?? -1);
    const record = proof.records.get(offset);
    if (offset < Math.max(floor, proof.since) || record === undefined || !HASH.test(message.content_sha256 ?? '')) return false;
    const native = transcriptRecordEvents(adapter.normalize(record, sessionId), offset)
      .find(event => event.event_id === message.own_event);
    return native?.kind === 'message' && native.role === message.role
      && transcriptDigest(native.content) === message.content_sha256;
  };
}

// What this context generation provably holds: pending frames the host
// recorded in a model-facing record (readPreferenceEvidence keeps only those,
// and drops them at a reset), hashed over the token and the whole recovery
// block exactly as the model saw them, never over a structured copy; and the
// session's own messages. Without a proven generation start (`floor` null)
// neither counts.
export function recentEvidence(proof, pending, { sessionId, adapter, floor }) {
  if (!proof.known || floor === null) return NO_EVIDENCE;
  const recorded = new Set(proof.frames.filter(frame => frame.confirms && frame.offset >= floor).map(frame => recentFrameHash(frame.visible)));
  return { frames: pending.filter(item => recorded.has(item.frameHash)),
    native: nativeMessageProof(proof, { sessionId, adapter, floor }) };
}

// Leaves out the versions this session has seen and names any confirmed
// version that the Provider explicitly replaced at the same sequence. A message
// that left the window, or a prefix of it, proves nothing either way.
export function projectRecentContext(value, { frames, native } = NO_EVIDENCE) {
  const recovery = value?.conversation?.recovery;
  if (!Array.isArray(recovery?.messages) || typeof recovery.conversation_id !== 'string') return { value, frame: null };
  // The versions each sequence currently holds in this context, replayed in
  // delivery order: a confirmed withdrawal takes its version out again, so a
  // version that comes back (A→B→A) is delivered and the one it replaces withdrawn.
  const seen = new Map();
  const versions = sequence => seen.get(sequence) ?? seen.set(sequence, new Set()).get(sequence);
  for (const frame of frames.filter(item => item.conversationId === recovery.conversation_id)) {
    for (const [sequence, hash] of frame.withdrawn) versions(sequence).delete(hash);
    for (const [sequence, hash] of frame.messages) versions(sequence).add(hash);
  }
  for (const message of recovery.messages) if (native(message)) versions(message.sequence).add(message.content_sha256);
  const messages = [], sent = [], withdrawn = [];
  for (const message of recovery.messages) {
    const hash = HASH.test(message.content_sha256 ?? '') ? message.content_sha256 : null;
    const held = seen.get(message.sequence) ?? new Set();
    if (hash && held.has(hash)) continue;
    messages.push(withoutProofs(message));
    if (!hash) continue;
    // A prefix never confirms the whole message.
    if (message.truncated !== true) sent.push([message.sequence, hash]);
    for (const old of held) withdrawn.push([message.sequence, old]);
  }
  const omitted = recovery.messages.length - messages.length;
  const seenAll = omitted && !messages.length && !withdrawn.length;
  // Nothing new: only where the window stands and the latest saved result.
  const view = seenAll ? { conversation_id: recovery.conversation_id, revision: recovery.revision,
    latest_checkpoint: recovery.latest_checkpoint ?? null, summary_role: recovery.summary_role,
    messages_omitted: omitted, omitted_reason: 'seen_in_session' }
    : { ...recovery, messages,
      ...(omitted ? { messages_omitted: omitted, omitted_reason: 'seen_in_session' } : {}),
      ...(withdrawn.length ? { withdrawn: { sequences: [...new Set(withdrawn.map(([sequence]) => sequence))],
        guidance: WITHDRAWN_GUIDANCE } } : {}) };
  // A tiny omitted message can cost less than the omitted-count metadata.
  // Keep the full window in that case, without losing a required withdrawal.
  if (omitted && !withdrawn.length && Buffer.byteLength(JSON.stringify(view))
      >= Buffer.byteLength(JSON.stringify(withoutDeliveryProofs(value).conversation.recovery))) {
    return projectRecentContext(value);
  }
  return { value: { ...value, conversation: { ...value.conversation, recovery: view } },
    frame: sent.length || withdrawn.length ? { conversationId: recovery.conversation_id,
      messages: sent.slice(0, MAX_FRAME_ITEMS), withdrawn: withdrawn.slice(0, MAX_FRAME_ITEMS) } : null };
}

// Pending only once the delivered result carries this exact, untruncated
// recovery block. Being produced is not being seen: a later read of the
// session's own transcript has to find the same frame.
export function deliveredRecentFrame(frame, projected, result) {
  const delivered = result?.structuredContent;
  if (!frame || result.isError || delivered?.truncated === true
      || !isDeepStrictEqual(recoveryView(delivered),
        JSON.parse(JSON.stringify(recoveryView(withoutDeliveryProofs(projected)))))) return null;
  return { ...frame, frameHash: recentFrameHash(delivered) };
}

// Explicit resume/context and raw-history results keep their public shape and
// are never delta-delivered. Only whole messages can prove a later hook window.
export function conversationResultRecovery(value) {
  if (value?.truncated === true) return null;
  if (Array.isArray(value?.context?.messages) && typeof value.context.conversation_id === 'string') return value.context;
  if (typeof value?.id !== 'string' || !Array.isArray(value.events)) return null;
  return { conversation_id: value.id, messages: value.events.filter(event => event.kind === 'message'
    && event.truncated !== true && ['user', 'assistant'].includes(event.role))
    .map(({ sequence, role, content }) => ({ sequence, role, content })) };
}

export function deliveredConversationFrame(value, result) {
  const recovery = conversationResultRecovery(value);
  if (!recovery) return null;
  const messages = recovery.messages.filter(message => message.truncated !== true && Number.isSafeInteger(message.sequence)
    && typeof message.content === 'string').map(message => [message.sequence, transcriptDigest(message.content)]);
  if (!messages.length) return null;
  return deliveredRecentFrame({ conversationId: recovery.conversation_id,
    messages: messages.slice(0, MAX_FRAME_ITEMS), withdrawn: [] }, value, result);
}

export function validRecentFrames(value) {
  const pairs = list => Array.isArray(list) && list.length <= MAX_FRAME_ITEMS
    && list.every(item => Array.isArray(item) && item.length === 2 && Number.isSafeInteger(item[0]) && HASH.test(item[1]));
  return Array.isArray(value) && value.length <= MAX_RECENT_FRAMES && value.every(item => typeof item?.conversationId === 'string'
    && item.conversationId.length <= 256 && HASH.test(item.frameHash ?? '') && pairs(item.messages) && pairs(item.withdrawn));
}

function recentFrameHash(value) {
  if (!value?.conversation?.recovery && conversationResultRecovery(value)) {
    return contentHash({ purpose: 'conversation-result-v1', result: value });
  }
  const recovery = recoveryView(value);
  return recovery && typeof recovery === 'object'
    ? contentHash({ purpose: 'recent-context-v1', token: value.taskContextToken ?? null, recovery }) : null;
}

const recoveryView = value => value?.conversation?.recovery ?? conversationResultRecovery(value);

function hasProofs(message) {
  return PROOF_FIELDS.some(field => Object.hasOwn(message ?? {}, field));
}

function withoutProofs(message) {
  if (!hasProofs(message)) return message;
  const { content_sha256: _hash, own_event: _event, ...visible } = message;
  return visible;
}
