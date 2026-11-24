import { sha256Bytes } from '../security/digest.js';
import { GLOBAL_WRITES_ENTRY, REPLAY_MAX_BYTES } from './protocol.js';

// The global writes port (graphiti/global-writes-port.js) of a follower's own
// half (local-scope-server.js): a checkpoint of a project this computer owns
// hands its writes to global, which the host owns, to this computer's outbox
// as one `global_writes` entry, and the host applies it op by op
// (host-global-writes.js). Nothing of global is written here.
//
// - One key, one entry: the entry id is the key's digest, so a checkpoint
//   retried under the same key reads what became of its first entry and never
//   queues a second.
// - Sent only to a host whose hello says it applies them (globalWrites: 1);
//   for an older host the entry is held here, said as such, and sent once the
//   host runs another version (outbox-delivery.js). One the host kept failing
//   on is held as well, and tried again at the next hello (requeueHeldWrites).
// - Online, the call waits a while for its own delivery (runner-mcp.js
//   waitForDelivery): only an entry the host answered counts as delivered.
//   What the host applied is `delivered`, what still waits is `queued`, what
//   it refused for good is `refused` with its code, each op as the host
//   answered it.
// - Writes larger together than the host takes (REPLAY_MAX_BYTES) go as one
//   entry per op instead, each under an id its key and place decide; an op
//   larger on its own is not sent to be refused there: it is kept here as
//   refused (`entry_too_large`), listed with the others, and the checkpoint says so.
//
// The ops of an entry the host answered that it could not take yet
// (host_too_old: its Provider has no way to apply them) are held under the
// next id, again until the host runs another version. The host's other
// refusals, and an op it skipped part of, are its answer and are not tried again.
const HOLD_PREFIX = 'host_too_old:';
// Held after MAX_HOST_FAILURES answers of 5xx in a row (outbox-delivery.js), with the host's version then.
const FAILING_PREFIX = 'host_keeps_failing:';
const RETRIED_CODES = new Set(['host_too_old']);
const ENTRY_TOO_LARGE = 'entry_too_large';

// The id of the entry for this key, or of a recruitment (owner-recruitments.js): its digest, within ENTRY_ID.
export function writesEntryId(kind, key) {
  return `${kind}:${sha256Bytes(Buffer.from(String(key), 'utf8')).slice(0, 40)}`;
}

// Whether the host this connection reached applies a follower's writes to global.
export function hostTakesGlobalWrites(host) {
  return Number.isInteger(host?.globalWrites) && host.globalWrites >= 1;
}

// Why an entry is held: until a host other than this version answers.
export function holdReason(hostVersion) {
  return `${HOLD_PREFIX}${hostVersion ?? ''}`;
}

// Why an entry is held after the host kept failing on it.
export function failingReason(hostVersion) {
  return `${FAILING_PREFIX}${hostVersion ?? ''}`;
}

// Whether an entry with this reason is held here to be sent again (not refused for good):
// 'host_too_old', 'host_keeps_failing', or null.
export function heldBecause(reason) {
  if (typeof reason !== 'string') return null;
  return reason.startsWith(HOLD_PREFIX) ? 'host_too_old' : reason.startsWith(FAILING_PREFIX) ? 'host_keeps_failing' : null;
}

// The held entries this host may take now, queued again. A host that applies
// writes to global takes those held for another version, an older one or one
// it kept failing on; and every hello that is new (a connection opened again,
// newHello) gives those it kept failing on one more round, so nothing held
// waits for ever, nor is tried every round. Answers how many were queued.
export function requeueHeldWrites(store, host, { newHello = false } = {}) {
  if (!hostTakesGlobalWrites(host)) return 0;
  const version = host.version ?? '';
  return store.requeueHeld(HOLD_PREFIX, version) + store.requeueHeld(FAILING_PREFIX, newHello ? null : version);
}

// The ops of one entry the host answered (its body { result: { ops } }), kept
// as the host answered each: delivered, with the ops it refused for good listed
// under `<id>:refused` and those it could not take yet held under the next id.
// Answers how many it applied; an answer that does not say, op by op, is kept as refused.
export function settleGlobalWrites(store, entry, body, hostVersion) {
  const ops = entry.input?.ops ?? [];
  const outcomes = body?.result?.ops;
  if (!Array.isArray(outcomes) || outcomes.length !== ops.length
    || outcomes.some((outcome) => !['applied', 'refused'].includes(outcome?.outcome))) {
    store.failed(entry.id, 'host_answer_invalid');
    return 0;
  }
  const refused = ops.map((op, index) => [op, outcomes[index]])
    .filter(([, outcome]) => outcome.outcome === 'refused' && !RETRIED_CODES.has(outcome.code));
  const again = ops.filter((_op, index) => outcomes[index].outcome === 'refused' && RETRIED_CODES.has(outcomes[index].code));
  store.settleWrites(entry.id, { input: { ...entry.input, outcomes },
    refused: refused.length ? { id: `${entry.id}:refused`, input: { ops: refused.map(([op]) => op), outcomes: refused.map(([, outcome]) => outcome) },
      reason: refusedReason(refused.map(([, outcome]) => outcome)) } : null,
    again: again.length ? { id: nextId(entry.id), input: { ops: again }, reason: holdReason(hostVersion) } : null });
  return outcomes.filter((outcome) => outcome.outcome === 'applied').length;
}

// What became of the ops of this entry, and of the ops held from it under the next ids:
// { delivered, queued, refused: [{ kind, code }] }, as the checkpoint repeats it.
export function writesAnswer(store, id, count) {
  const entry = store.entry(id);
  if (!entry || entry.state === 'queued' || heldBecause(entry.reason)) return { delivered: 0, queued: count, refused: [] };
  if (entry.state === 'failed') {
    return { delivered: 0, queued: 0, refused: (entry.input?.ops ?? []).map((op) => ({ kind: op.kind, code: entry.reason })) };
  }
  const outcomes = entry.input?.outcomes ?? [];
  const retried = outcomes.filter((outcome) => outcome.outcome === 'refused' && RETRIED_CODES.has(outcome.code)).length;
  const later = retried ? writesAnswer(store, nextId(id), retried) : { delivered: 0, queued: 0, refused: [] };
  return { delivered: outcomes.filter((outcome) => outcome.outcome === 'applied').length + later.delivered,
    queued: later.queued,
    refused: [...outcomes.filter((outcome) => outcome.outcome === 'refused' && !RETRIED_CODES.has(outcome.code))
      .map(({ kind, code }) => ({ kind, code })), ...later.refused] };
}

// The port. waitForDelivery(id): delivers the outbox now and waits a while
// for this entry while the host answers (runner-mcp.js).
export function createGlobalWritesOutbox({ store, sourceApplication, sessionId, waitForDelivery }) {
  return Object.freeze({
    elsewhere: () => true,
    async send({ key, ops }) {
      const entries = writesEntries({ key, ops, sourceApplication, sessionId });
      for (const { id, input, bytes } of entries) {
        if (store.entry(id)) continue;
        store.enqueue({ id, tool: GLOBAL_WRITES_ENTRY, input, sourceApplication, sessionId,
          heldFor: bytes > REPLAY_MAX_BYTES ? ENTRY_TOO_LARGE : null });
      }
      for (const { id } of entries) if (store.entry(id)?.state === 'queued') await waitForDelivery(id);
      return entries.map(({ id, input }) => writesAnswer(store, id, input.ops.length))
        .reduce((all, one) => ({ delivered: all.delivered + one.delivered, queued: all.queued + one.queued,
          refused: [...all.refused, ...one.refused] }));
    }
  });
}

// The entries of one checkpoint's writes: one for all of them, or, when they
// are larger together than the host takes, one per op (the key's id with the
// op's place and kind). bytes: as the host reads it, the whole replay request.
function writesEntries({ key, ops, sourceApplication, sessionId }) {
  const entry = (id, input) => ({ id, input, bytes: Buffer.byteLength(JSON.stringify({ id, tool: GLOBAL_WRITES_ENTRY, input,
    sourceApplication, sessionId, offlineTask: null })) });
  const whole = entry(writesEntryId('global', key), { ops });
  if (whole.bytes <= REPLAY_MAX_BYTES || ops.length < 2) return [whole];
  return ops.map((op, index) => entry(writesEntryId('global', `${key}\u0000${index}:${op.kind}`), { ops: [op] }));
}

// `<id>.1`, `<id>.2`, …: the entry that holds the ops an earlier one could not deliver yet.
function nextId(id) {
  const match = /^(.*)\.(\d+)$/.exec(id);
  return match ? `${match[1]}.${Number(match[2]) + 1}` : `${id}.1`;
}

// One line, as the outbox lists a refused entry: each op's kind and the host's code.
function refusedReason(outcomes) {
  return `host_refused: ${outcomes.map(({ kind, code }) => `${kind} ${code}`).join(', ')}`.slice(0, 200);
}
