import { join } from 'node:path';

import { openRoutes } from './call-routes.js';
import { holdPreparationLock, readLocalRuntime } from './follower-local-runtime.js';
import { GLOBAL_SYNC_EVERY_MS, readGlobalCopyRecord, recordGlobalCopy } from './global-copy-state.js';
import { globalIsCopyHere } from './global-copy.js';
import { hostSpaceFrom, withHostConnection } from './host-space.js';
import { localGraphHealth, localGraphImport, localGraphSpaceId } from './local-graph-projects.js';
import { RUNNER_PATHS, SCOPE_DIGEST_HEADER, SCOPE_ENVELOPE_MAX_BYTES } from './protocol.js';
import { GLOBAL_SCOPE } from './routes-store.js';

// A follower's read-only copy of its host's `global` (docs/runner-roles-design.md
// §3, §12 "The sync loop"). The host owns `global` (D1) and keeps writing it;
// this computer imports the host's export into its own graph, under the same
// IDs, and never writes it otherwise. Nothing reads the copy yet: every call
// still goes to the host (reading the copy is the step that makes a project local).
//
// When: once when the preparation has made the graph under the host's space
// (Neo4j runs then anyway, follower-runtime-prepare.js), and after that only
// while this computer's own runtime already runs (startGlobalSync): a follower
// with no scope of its own does not keep Neo4j running, and it is never started
// for a sync. While it runs: once when this process first finds it running, and
// then every GLOBAL_SYNC_EVERY_MS, asking the host for the digest only and
// fetching the envelope only when the digest is not the copy's.
//
// One sync, in this order, each step said in the state when it stops there
// (global-copy-state.js): global is a copy here (globalIsCopyHere); the host
// said its space and versions (hello); the host's space is this graph's; the
// two graph formats and copy protocols are one; the host's digest; the
// envelope; the import, under the preparation's lock, so one import at a time
// runs for the space and none while a preparation starts or stops the runtime.
// `owner` is the fingerprint the pairing pinned, never anything the envelope says.
// A refusal (409, 422) is recorded as it was said and not tried again while the
// digest, both versions and the space are what they were.
const ASK_MS = 30_000;
// How often a running process looks whether a sync is due; the look itself reads two small files.
const TICK_MS = 60_000;

// hostSpace: hostSpaceFrom(the hello just answered), or { known: false, reason }.
// ownFormats: { graph, replicaProtocol } this computer's Provider says now.
// importInto({ envelope, owner }): localGraphImport's answer.
// hold(): the preparation's lock, released by calling what it answers; null when it is held elsewhere.
export async function syncGlobalCopy({ dataDir, store, connection, hostSpace, ownFormats, localSpaceId, importInto,
  hold = () => holdPreparationLock(dataDir, { waitMs: 0 }), now = Date.now }) {
  const host = store.host();
  if (!host || host.revokedAt || !globalIsCopyHere(dataDir)) return { outcome: 'not_a_copy' };
  const at = () => new Date(now()).toISOString();
  const stop = (last) => {
    recordGlobalCopy(dataDir, { last: { at: at(), ...last } });
    return last;
  };
  if (!hostSpace?.known) {
    if (hostSpace?.reason === 'host_too_old') return stop({ outcome: 'host_cannot_copy', reason: 'host_too_old' });
    return stop({ outcome: 'waiting', reason: hostSpace?.reason === 'host_space_pending' ? 'host_space_pending' : 'host_unreachable' });
  }
  const own = { graph: ownFormats?.graph ?? null, replicaProtocol: ownFormats?.replicaProtocol ?? null };
  const differ = (asked) => asked.graph !== own.graph || asked.replicaProtocol !== own.replicaProtocol;
  if (hostSpace.spaceId !== localSpaceId) return stop({ outcome: 'space_differs', spaceId: hostSpace.spaceId });
  const said = { graph: hostSpace.graphFormat, replicaProtocol: hostSpace.replicaProtocol };
  if (differ(said)) return stop({ outcome: 'versions_differ', host: said, own });

  const asked = await askHost(connection, 'digest');
  if (asked.stop) return stop(asked.stop);
  const summary = asked.body ?? {};
  const theirs = { graph: summary.graphFormat ?? null, replicaProtocol: summary.replicaProtocol ?? null };
  // The export says the space it is of now: a hello read minutes ago may name an earlier one.
  if (summary.spaceId !== localSpaceId) return stop({ outcome: 'space_differs', spaceId: summary.spaceId ?? null });
  if (differ(theirs)) return stop({ outcome: 'versions_differ', host: theirs, own });
  const record = readGlobalCopyRecord(dataDir);
  if (typeof summary.digest === 'string' && summary.digest === record.digest) {
    const last = { outcome: 'synced', unchanged: true, digest: summary.digest };
    recordGlobalCopy(dataDir, { checkedAt: at(), last: { at: at(), ...last } });
    return last;
  }
  const situation = { digest: summary.digest ?? null, host: theirs, own, spaceId: localSpaceId };
  if (refusedBefore(record.last, situation)) return { ...record.last, repeated: true };
  if (summary.complete !== true) {
    return stop({ outcome: 'refused', by: 'host', code: 'replica_envelope_incomplete', ...situation });
  }

  const fetched = await askHost(connection, 'envelope');
  if (fetched.stop) return stop(fetched.stop.outcome === 'refused' ? { ...fetched.stop, ...situation } : fetched.stop);
  const digest = fetched.headers?.get(SCOPE_DIGEST_HEADER) || summary.digest || null;
  const release = hold();
  if (!release) return { outcome: 'busy' };
  let answer;
  try {
    answer = await importInto({ envelope: fetched.text, owner: host.fingerprint });
  } finally {
    release();
  }
  if (answer.unreachable) return stop({ outcome: 'waiting', reason: 'own_runtime_stopped' });
  if (answer.refused) {
    return stop({ outcome: 'refused', by: 'here', code: answer.code, message: answer.message, ...situation, digest });
  }
  const syncedAt = at();
  const routes = openRoutes(dataDir);
  try { routes.replicaSynced(GLOBAL_SCOPE, syncedAt); } finally { routes.close(); }
  const last = { outcome: 'synced', digest };
  recordGlobalCopy(dataDir, { digest, checkedAt: syncedAt, changedAt: syncedAt, last: { at: syncedAt, ...last } });
  return { ...last, imported: answer.imported };
}

// The host's digest or envelope of global: { body } / { text, headers }, or { stop } with
// what the state says. A 404 is a host whose FULI has no copies to give (an earlier version).
async function askHost(connection, part) {
  const path = `${RUNNER_PATHS.scope}?scope=${GLOBAL_SCOPE}&part=${part}`;
  const answer = await connection.getText(path, { timeoutMs: ASK_MS, maxBytes: SCOPE_ENVELOPE_MAX_BYTES });
  if (!answer.reachable) return { stop: { outcome: 'waiting', reason: 'host_unreachable' } };
  if (answer.tooLarge) {
    return { stop: { outcome: 'refused', by: 'here', code: 'scope_too_large', max: SCOPE_ENVELOPE_MAX_BYTES } };
  }
  if (answer.revoked) return { stop: { outcome: 'waiting', reason: 'host_unreachable' } };
  if (answer.status === 404) return { stop: { outcome: 'host_cannot_copy', reason: 'no_scope_route' } };
  if (answer.status !== 200) {
    let body = null;
    try { body = JSON.parse(answer.text); } catch { body = null; }
    const code = typeof body?.error === 'string' ? body.error : `http_${answer.status}`;
    if (code === 'host_provider_unavailable' || code === 'host_provider_slow') return { stop: { outcome: 'waiting', reason: code } };
    return { stop: { outcome: 'refused', by: 'host', code, message: String(body?.message ?? '').slice(0, 300),
      ...(Number.isInteger(body?.bytes) ? { bytes: body.bytes, max: body.max } : {}) } };
  }
  if (part === 'envelope') return { text: answer.text, headers: answer.headers };
  try { return { body: JSON.parse(answer.text) }; } catch {
    return { stop: { outcome: 'refused', by: 'host', code: 'host_answer_invalid' } };
  }
}

// The same refusal again: nothing changed on either side since it was said.
function refusedBefore(last, { digest, host, own, spaceId }) {
  return last?.outcome === 'refused' && last.digest === digest && last.spaceId === spaceId
    && last.host?.graph === host.graph && last.host?.replicaProtocol === host.replicaProtocol
    && last.own?.graph === own.graph && last.own?.replicaProtocol === own.replicaProtocol;
}

// The first sync, from the preparation, which holds the lock and has the runtime running.
// hostSpace: what the preparation's own hello said. Never throws: a sync that did not
// succeed is in the state, and the preparation goes on as before.
export async function syncFromPreparation({ dataDir, configPath, hostSpace, ownFormats, withHost = withHostConnection,
  importInto = (input) => localGraphImport(configPath, input), now = Date.now }) {
  try {
    return await withHost(dataDir, { ownFormats }, ({ store, connection }) => syncGlobalCopy({ dataDir, store, connection,
      hostSpace, ownFormats, localSpaceId: localGraphSpaceId(configPath), importInto, hold: () => () => {}, now }))
      ?? { outcome: 'not_a_copy' };
  } catch (error) {
    return { outcome: 'failed', message: String(error?.message ?? error).slice(0, 300) };
  }
}

// The sync while this computer's own runtime already runs, in the follower console's process.
// Each TICK_MS, once a sync is due, it reads whether the runtime is prepared under the host's
// space (a small file); only then does it ask this computer's own Provider whether it runs (on
// loopback; nothing is started), and only when it does, the host. close() stops it.
export function startGlobalSync({ dataDir, store, connection, every = GLOBAL_SYNC_EVERY_MS, tick = TICK_MS,
  health = (configPath) => localGraphHealth(configPath), sync = syncGlobalCopy, now = Date.now,
  importInto = null }) {
  const configPath = join(dataDir, 'graph-runtime.json');
  let lastRound = null;
  let busy = false;
  // Due at the first round this process finds the runtime running, then every `every`; sooner
  // after a round the host did not answer, as soon as this process reached the host again.
  const due = () => lastRound === null || now() - lastRound.at >= every
    || (lastRound.unreachable && Boolean(connection.current));
  async function round() {
    if (busy || !due()) return null;
    const prepared = readLocalRuntime(dataDir);
    if (prepared.state !== 'ready' || prepared.space?.state !== 'same') return null;
    busy = true;
    try {
      const own = await health(configPath);
      if (own.unreachable || own.refused || own.globalReplica !== true) return null;
      const hello = await connection.hello();
      const hostSpace = hello ? hostSpaceFrom(hello) : { known: false, reason: 'host_unreachable' };
      const outcome = await sync({ dataDir, store, connection, hostSpace, ownFormats: own,
        localSpaceId: localGraphSpaceId(configPath), importInto: importInto ?? ((input) => localGraphImport(configPath, input)), now });
      lastRound = { at: now(), unreachable: outcome?.reason === 'host_unreachable' };
      return outcome;
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => { round().catch(() => {}); }, tick);
  timer.unref?.();
  return { round, close: () => clearInterval(timer) };
}
