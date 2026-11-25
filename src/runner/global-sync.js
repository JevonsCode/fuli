import { replicaContentMatches } from './replica-content.js';
import { join } from 'node:path';

import { openRoutes } from './call-routes.js';
import { copyCatchUp, holdPreparationLock, PREPARE_RETRY_MOST_MS, PREPARE_RETRY_MS, prepareInBackground, readLocalRuntime,
  readRecord } from './follower-local-runtime.js';
import { GLOBAL_SYNC_EVERY_MS, IMPORT_UNFINISHED, readGlobalCopyRecord, recordGlobalCopy, requestSyncSoon, syncSoonDue } from './global-copy-state.js';
import { globalIsCopyHere } from './global-copy.js';
import { hostSpaceFrom, withHostConnection } from './host-space.js';
import { localGraphHealth, localGraphImport, localGraphReplicaSummary, localGraphSpaceId, localProviderRecorded } from './local-graph-projects.js';
import { RUNNER_PATHS, SCOPE_DIGEST_HEADER, SCOPE_ENVELOPE_MAX_BYTES } from './protocol.js';
import { deliverOutbox } from './outbox-delivery.js';
import { ownsLocalProjects } from './owned-project-routes.js';
import { GLOBAL_SCOPE } from './routes-store.js';

// A follower's read-only copy of its host's `global` (docs/runner-roles-design.md
// §3, §12 "The sync loop"). The host owns `global` (D1) and keeps writing it;
// this computer imports the host's export into its own graph, under the same
// IDs, and never writes it otherwise. Nothing reads the copy yet: every call
// still goes to the host (reading the copy is the step that makes a project local).
//
// When: when the preparation has made the graph under the host's space (Neo4j
// runs then anyway, follower-runtime-prepare.js); once more by the preparation
// while a copy is owed (follower-local-runtime.js copyCatchUp: none arrived
// yet, or FULI changed since), started only when the host answers and would not
// say the same refusal again (copyWorthStarting), and stopped after; and while
// this computer's own runtime already runs (startGlobalSync). Once a copy
// arrived, a follower with no scope of its own does not keep Neo4j running and
// it is not started for a sync. While it runs: once when this process first
// finds it running, and then every GLOBAL_SYNC_EVERY_MS, asking the host for the
// digest only and fetching the envelope only when the digest is not the copy's
// (or the sync verifies, below).
//
// One sync, in this order, each step said in the state when it stops there
// (global-copy-state.js): global is a copy here (globalIsCopyHere); the host
// said its space and versions (hello); the host's space is this graph's; the
// two graph formats and copy protocols are one; the host's digest; the
// envelope; the import, under the preparation's lock, so one import at a time
// runs for the space and none while a preparation starts or stops the runtime.
// `owner` is the fingerprint the pairing pinned, never anything the envelope says.
// A refusal (409, 422) is recorded as it was said and not tried again while the
// digest, both versions and the space are what they were. A refusal of the digest
// itself (413, 409: there is no digest to compare) is not asked again while both
// versions and the space are what they were, for DIGEST_REFUSAL_AGAIN_MS.
//
// The digest kept here is what this computer last imported, not what its graph
// holds now: a graph something else wrote would still match it. So a sync with
// `verify` imports the envelope even when the digests match (the import is
// idempotent and writes back whatever differs from the host's): the preparation's
// syncs and, on a copy-only follower, periodic verification. A computer with
// local projects instead compares its live content digest with the last import,
// read (the whole copy, scope_replica_summary.py) only on a verifying round or
// after its last import did not finish or was refused; a restore forgets the
// digest (forgetDigest), so the next round imports anyway.
const ASK_MS = 30_000;
// How often a running process looks whether a sync is due: a small file first, and
// only when it names a running Provider, one request to it on loopback.
const TICK_MS = 60_000;
export const VERIFY_EVERY = 6;
export const DIGEST_REFUSAL_AGAIN_MS = 24 * 60 * 60_000;

// What the host says before anything is fetched: { stop } when the sync ends there (recorded),
// or { summary, situation, record } to go on. own: { graph, replicaProtocol }, or null when this
// computer's own formats are not known now (a FULI update since the preparation): not compared then.
async function askHostDigest({ dataDir, connection, hostSpace, own, localSpaceId, at, now }) {
  const stop = (last) => {
    recordGlobalCopy(dataDir, { last: { at: at(), ...last } });
    return { stop: last };
  };
  if (!hostSpace?.known) {
    if (hostSpace?.reason === 'host_too_old') return stop({ outcome: 'host_cannot_copy', reason: 'host_too_old' });
    return stop({ outcome: 'waiting', reason: hostSpace?.reason === 'host_space_pending' ? 'host_space_pending' : 'host_unreachable' });
  }
  const differ = (asked) => own !== null && (asked.graph !== own.graph || asked.replicaProtocol !== own.replicaProtocol);
  if (hostSpace.spaceId !== localSpaceId) return stop({ outcome: 'space_differs', spaceId: hostSpace.spaceId });
  const said = { graph: hostSpace.graphFormat, replicaProtocol: hostSpace.replicaProtocol };
  if (differ(said)) return stop({ outcome: 'versions_differ', host: said, own });
  const record = readGlobalCopyRecord(dataDir);
  const asking = { digest: null, host: said, own, spaceId: localSpaceId };
  if (record.last?.phase === 'digest' && refusedBefore(record.last, asking)
    && now() - Date.parse(record.last.at) < DIGEST_REFUSAL_AGAIN_MS) return { stop: { ...record.last, repeated: true } };

  const asked = await askHost(connection, 'digest');
  if (asked.stop) return stop(asked.stop.outcome === 'refused' ? { ...asked.stop, ...asking, phase: 'digest' } : asked.stop);
  const summary = asked.body ?? {};
  const theirs = { graph: summary.graphFormat ?? null, replicaProtocol: summary.replicaProtocol ?? null };
  // The export says the space it is of now: a hello read minutes ago may name an earlier one.
  if (summary.spaceId !== localSpaceId) return stop({ outcome: 'space_differs', spaceId: summary.spaceId ?? null });
  if (differ(theirs)) return stop({ outcome: 'versions_differ', host: theirs, own });
  const situation = { digest: summary.digest ?? null, host: theirs, own, spaceId: localSpaceId };
  return { summary, situation, record };
}

// hostSpace: hostSpaceFrom(the hello just answered), or { known: false, reason }.
// ownFormats: { graph, replicaProtocol } this computer's Provider says now.
// importInto({ envelope, owner }): localGraphImport's answer.
// hold(): the preparation's lock, released by calling what it answers; null when it is held elsewhere.
// verify: import even when the host's digest is the one recorded (see above).
export async function syncGlobalCopy({ dataDir, store, connection, hostSpace, ownFormats, localSpaceId, importInto,
  hold = () => holdPreparationLock(dataDir, { waitMs: 0 }), now = Date.now, verify = false, replicaSummary = null }) {
  const host = store.host();
  if (!host || host.revokedAt || !globalIsCopyHere(dataDir)) return { outcome: 'not_a_copy' };
  const at = () => new Date(now()).toISOString();
  const stop = (last) => {
    recordGlobalCopy(dataDir, { last: { at: at(), ...last } });
    return last;
  };
  const own = { graph: ownFormats?.graph ?? null, replicaProtocol: ownFormats?.replicaProtocol ?? null };
  const checked = await askHostDigest({ dataDir, connection, hostSpace, own, localSpaceId, at, now });
  if (checked.stop) return checked.stop;
  const { summary, situation, record } = checked;
  const same = typeof summary.digest === 'string' && summary.digest === record.digest;
  let unchanged = same && !verify;
  if (same && replicaSummary) {
    const current = record.contentDigest ? await replicaSummary() : null;
    if (current?.unreachable || current?.refused) {
      return stop({ outcome: 'waiting', reason: 'replica_summary_unavailable' });
    }
    unchanged = replicaContentMatches(record, current);
  }
  if (unchanged) {
    const last = { outcome: 'synced', unchanged: true, digest: summary.digest };
    recordGlobalCopy(dataDir, { checkedAt: at(), last: { at: at(), ...last } });
    return last;
  }
  if (!same && refusedBefore(record.last, situation)) return { ...record.last, repeated: true };
  if (summary.complete !== true) {
    return stop({ outcome: 'refused', by: 'host', code: 'replica_envelope_incomplete', ...situation });
  }

  const fetched = await askHost(connection, 'envelope');
  if (fetched.stop) return stop(fetched.stop.outcome === 'refused' ? { ...fetched.stop, ...situation } : fetched.stop);
  const digest = fetched.headers?.get(SCOPE_DIGEST_HEADER) || summary.digest || null;
  const release = hold();
  if (!release) return { outcome: 'busy' };
  let routes;
  try {
    // Said before anything is written: `fuli runner leave` must know a copy may be in this graph
    // even when this process ends between the import and the record below.
    if (store.host()?.fingerprint !== host.fingerprint || !globalIsCopyHere(dataDir)) return { outcome: 'not_a_copy' };
    routes = openRoutes(dataDir);
    routes.replicaArriving(GLOBAL_SCOPE);
    const answer = await importInto({ envelope: fetched.text, owner: host.fingerprint });
    if (answer.unreachable) {
      return stop({ outcome: 'waiting', reason: IMPORT_UNFINISHED, cause: answer.timedOut ? 'timeout' : 'interrupted',
        ...situation, digest });
    }
    if (answer.refused) {
      return stop({ outcome: 'refused', by: 'here', code: answer.code, message: answer.message, ...situation, digest });
    }
    const syncedAt = at();
    routes.replicaSynced(GLOBAL_SCOPE, syncedAt);
    // A verifying import of the same digest that wrote nothing found the copy as the host has it.
    const changed = digest !== record.digest || wrote(answer.imported);
    const last = { outcome: 'synced', digest, ...(changed ? {} : { unchanged: true }),
      ...(same && changed ? { corrected: true } : {}) };
    recordGlobalCopy(dataDir, { digest, contentDigest: answer.imported?.contentDigest, checkedAt: syncedAt, ...(changed ? { changedAt: syncedAt } : {}),
      last: { at: syncedAt, ...last } });
    return { ...last, imported: answer.imported };
  } finally {
    routes?.close();
    release();
  }
}

// The last import here timed out, was interrupted or was refused: the copy may not be what was recorded.
function importDidNotFinish(last) {
  return (last?.outcome === 'waiting' && last.reason === IMPORT_UNFINISHED) || (last?.outcome === 'refused' && last.by === 'here');
}

// Whether an import's counts (scope_import.py) say it wrote anything.
function wrote(imported) {
  const counts = [imported?.nodes, imported?.relationships];
  return counts.some((part) => ['created', 'updated', 'deleted'].some((name) => Number(part?.[name]) > 0));
}

// Whether the preparation should start this computer's runtime for a copy it owes
// (follower-local-runtime.js copyCatchUp), asked with no runtime running: only the
// host's hello and digest, never the envelope. why: 'first' (no copy arrived yet;
// own: the formats the preparation recorded) or 'upgrade' (FULI changed since: own
// formats unknown until the Provider runs, so the host need only answer). Not
// when the host is away, or the last try was the same refusal or version
// mismatch in the same situation: each would start Neo4j for nothing.
export async function copyWorthStarting({ dataDir, why, ownFormats = null, withHost = withHostConnection,
  localSpaceId, now = Date.now }) {
  try {
    return await withHost(dataDir, { ownFormats }, async ({ store, connection }) => {
      if (!store.host() || store.host().revokedAt || !globalIsCopyHere(dataDir)) return { start: false, outcome: 'not_a_copy' };
      const greeting = await connection.hello();
      const hostSpace = greeting ? hostSpaceFrom(greeting) : { known: false, reason: 'host_unreachable' };
      const at = () => new Date(now()).toISOString();
      const own = why === 'upgrade' || !ownFormats ? null
        : { graph: ownFormats.graph ?? null, replicaProtocol: ownFormats.replicaProtocol ?? null };
      const checked = await askHostDigest({ dataDir, connection, hostSpace, own, localSpaceId, at, now });
      if (checked.stop) return { start: false, ...checked.stop };
      if (why !== 'upgrade' && (refusedBefore(checked.record.last, checked.situation)
        || unfinishedBefore(checked.record.last, checked.situation))) {
        return { start: false, ...checked.record.last, repeated: true };
      }
      return { start: true, hostSpace };
    }) ?? { start: false, outcome: 'not_a_copy' };
  } catch (error) {
    return { start: false, outcome: 'failed', message: String(error?.message ?? error).slice(0, 300) };
  }
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
  return last?.outcome === 'refused' && (last.digest ?? null) === digest && last.spaceId === spaceId
    && sameFormats(last.host, host) && sameFormats(last.own, own);
}

// This computer's runtime was started for the same copy in the same situation and its import
// did not finish: starting it again would only time out again, until something changes.
function unfinishedBefore(last, { digest, host, own, spaceId }) {
  return last?.outcome === 'waiting' && last.reason === IMPORT_UNFINISHED && last.again !== true
    && (last.digest ?? null) === digest && last.spaceId === spaceId && sameFormats(last.host, host) && sameFormats(last.own, own);
}

function sameFormats(said, now) {
  if (!said || !now) return !said && !now;
  return said.graph === now.graph && said.replicaProtocol === now.replicaProtocol;
}

// The first sync, from the preparation, which holds the lock and has the runtime running.
// hostSpace: what the preparation's own hello said. Never throws: a sync that did not
// succeed is in the state, and the preparation goes on as before.
export async function syncFromPreparation({ dataDir, configPath, hostSpace, ownFormats, withHost = withHostConnection,
  importInto = (input) => localGraphImport(configPath, input), now = Date.now }) {
  try {
    return await withHost(dataDir, { ownFormats }, ({ store, connection }) => syncGlobalCopy({ dataDir, store, connection,
      hostSpace, ownFormats, localSpaceId: localGraphSpaceId(configPath), importInto, hold: () => () => {}, now,
      verify: true }))
      ?? { outcome: 'not_a_copy' };
  } catch (error) {
    return { outcome: 'failed', message: String(error?.message ?? error).slice(0, 300) };
  }
}

// The sync while this computer's own runtime already runs, in the follower console's process.
// Each TICK_MS it reads whether the runtime is prepared under the host's space and whether the
// process record names a running Provider (two small files); only then does it ask that Provider
// whether it runs as a copy's (on loopback; nothing is started), and only when a sync is due, the host.
// A copy still owed while the runtime does not run (copyCatchUp: none arrived yet, or FULI changed
// since) is left to the preparation, started again here only once the host answers, after
// PREPARE_RETRY_MS, then twice as long each time up to PREPARE_RETRY_MOST_MS: the console's own
// start already started one (follower-runtime.js), and Neo4j is never started every minute.
// close() stops it.
export function startGlobalSync({ dataDir, store, connection, every = GLOBAL_SYNC_EVERY_MS, tick = TICK_MS,
  health = (configPath) => localGraphHealth(configPath), sync = syncGlobalCopy, now = Date.now,
  importInto = null, providerRecorded = () => localProviderRecorded(dataDir), owed = copyCatchUp,
  prepare = prepareInBackground, owns = ownsLocalProjects, queueRecruitments, deliver = deliverOutbox,
  replicaSummary = localGraphReplicaSummary, lease = null }) {
  const configPath = join(dataDir, 'graph-runtime.json');
  let lastRound = null;
  let lastConnection = null;
  let rounds = 0;
  let busy = false;
  let closed = false;
  let scheduled;
  let catchUp = { at: now(), waitMs: PREPARE_RETRY_MS };
  // Due at the first round this process finds the runtime running, then every `every`; sooner
  // after a round the host did not answer, as soon as this process reached the host again.
  const due = () => lastRound === null || syncSoonDue(readGlobalCopyRecord(dataDir), lastRound.at) || now() - lastRound.at >= every
    || (connection.current && (lastRound.unreachable || (connection.current !== lastConnection && owns(dataDir))));
  async function round() {
    if (busy || closed) return null;
    const record = readRecord(dataDir);
    const prepared = readLocalRuntime(dataDir);
    if (prepared.state !== 'ready' || prepared.space?.state !== 'same') return null;
    busy = true;
    try {
      // A computer with projects of its own syncs inside its broker's lease (follower-runtime-broker.js),
      // so the runtime does not go to sleep under an import; only while it runs anyway, and nothing
      // is started beside the broker for a copy owed.
      if (lease && owns(dataDir)) {
        if (!providerRecorded() || !due()) return null;
        return await lease(() => syncRound(true));
      }
      const own = providerRecorded() ? await health(configPath) : { unreachable: true };
      if (own.unreachable) return await owedCopy(record);
      return await syncRound(false, own);
    } finally {
      busy = false;
    }
  }
  async function syncRound(leased, known = null) {
    const own = known ?? await health(configPath);
    if (own.unreachable || own.refused || own.globalReplica !== true || !due()) return null;
    const roundStarted = now();
    const local = leased || owns(dataDir);
    if (local) await queueRecruitments?.();
    const hello = await connection.hello();
    if (local && hello) {
      await deliver({ store, connection, dataDir,
        onWritesApplied: () => requestSyncSoon(dataDir) });
      lastConnection = connection.current;
    }
    const hostSpace = hello ? hostSpaceFrom(hello) : { known: false, reason: 'host_unreachable' };
    const verify = rounds % VERIFY_EVERY === 0;
    const compare = local && (verify || importDidNotFinish(readGlobalCopyRecord(dataDir).last));
    const outcome = await sync({ dataDir, store, connection, hostSpace, ownFormats: own,
      localSpaceId: localGraphSpaceId(configPath), importInto: importInto ?? ((input) => localGraphImport(configPath, input)),
      now, verify, ...(compare ? { replicaSummary: () => replicaSummary(configPath) } : {}) });
    rounds += 1;
    lastRound = { at: roundStarted, unreachable: outcome?.reason === 'host_unreachable' };
    return outcome;
  }
  async function owedCopy(record) {
    if (now() - catchUp.at < catchUp.waitMs || !owed(dataDir, record)) return null;
    catchUp = { at: now(), waitMs: Math.min(catchUp.waitMs * 2, PREPARE_RETRY_MOST_MS) };
    const reached = connection.current ?? await connection.connect({ knownOnly: true });
    if (!reached) return null;
    let started = false;
    try { started = prepare({ dataDir }); } catch { started = false; }
    return started ? { outcome: 'preparing', reason: 'copy_owed' } : null;
  }
  const timer = setInterval(() => {
    scheduled ??= round().catch(() => {}).finally(() => { scheduled = null; });
  }, tick);
  timer.unref?.();
  return { round, close() { closed = true; clearInterval(timer); return scheduled; } };
}
