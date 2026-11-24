import { join } from 'node:path';

import { loadDeviceIdentity } from '../../packages/roundtable/src/peer/device-identity.js';
import { FULI_VERSION } from '../package-metadata.js';
import { createHostConnection } from './host-connection.js';
import { RUNNER_FILE, RunnerStore } from './runner-store.js';

// Whose personal space a follower's own graph is (docs/runner-roles-design.md
// §12, "A follower adopts the host's space ID"). Nearly every record ID and
// group_id in a graph is derived from the personal space ID and the Provider's
// provider_id, and a copy of `global` lands only in a graph with the same two
// (scope_import.py, replica_space_mismatch). So a host says both in its hello,
// with the versions a copy must match (its graph format and copy protocol),
// and a follower makes its own graph under them.
//
// Each side's FULI version is already in the hello (version-skew.js); these
// fields are only added, and a host of an earlier version leaves them out: the
// follower then says so and works on as before.

// Headers a follower sends with hello: its own versions, for the host to match
// against when copies flow (a later step reads them; nothing refuses on them).
export const FOLLOWER_VERSION_HEADER = 'x-fuli-follower-version';
export const FOLLOWER_GRAPH_FORMAT_HEADER = 'x-fuli-follower-graph-format';
export const FOLLOWER_REPLICA_PROTOCOL_HEADER = 'x-fuli-follower-replica-protocol';

const SPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// How long one health read may take, in the background; never what a hello waits.
const HEALTH_MS = 3000;
// How long a read answer is used before it is read again (the host's data directory can be made
// again, with another space ID, without this process knowing), and how long after a read that
// failed the next one starts: a hello never starts more than one.
const FRESH_MS = 5 * 60_000;
const RETRY_MS = 15_000;

// The host's side: what its hello adds, from its own graph runtime (the space from its settings,
// provider_id and formats from its Provider's health). A hello never waits for the Provider: a
// follower's whole look for its host (host-connection.js PROBE_MS) is shorter than a Provider
// that is starting may take to answer. So it answers what was read before, and reads in the
// background when that is missing or old: one read at a time, none again for RETRY_MS after one
// failed. Until a read succeeded it answers { space: null }, which a follower tells from an
// earlier host (no `space` at all). A read that fails forgets what was read, and so does a
// space ID in the settings other than the one read.
export function hostSpaceReader(app, { timeoutMs = HEALTH_MS, freshMs = FRESH_MS, retryMs = RETRY_MS, now = Date.now } = {}) {
  let known = null; // { spaceId, at, fields }
  let reading = false;
  let failedAt = null;
  const read = async (spaceId) => {
    reading = true;
    try {
      const health = await withTimeout(Promise.resolve().then(() => app.personal.health()), timeoutMs);
      if (typeof health?.providerId !== 'string') throw new Error('health without providerId');
      known = { spaceId, at: now(), fields: { space: { id: spaceId, providerId: health.providerId },
        formats: { graph: health.data_format?.supported_version ?? null, replicaProtocol: health.replicaProtocol ?? null } } };
      failedAt = null;
    } catch {
      known = null;
      failedAt = now();
    } finally {
      reading = false;
    }
  };
  return () => {
    const spaceId = app?.config?.personal?.spaceId;
    if (typeof spaceId !== 'string' || typeof app.personal?.health !== 'function') return {};
    if (known && known.spaceId !== spaceId) known = null;
    const due = !known || now() - known.at >= freshMs;
    if (due && !reading && (failedAt === null || now() - failedAt >= retryMs)) void read(spaceId);
    return known ? known.fields : { space: null };
  };
}

function withTimeout(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('health timeout')), ms); });
  timer.unref?.();
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// The follower's side: what one hello said of the host's space.
//   { known: true, spaceId, providerId, graphFormat, replicaProtocol }
//   { known: false, reason: 'host_space_pending' }: the host's Provider has not said it yet
//   { known: false, reason: 'host_too_old' }: the host answered without it
export function hostSpaceFrom(greeting) {
  const space = greeting?.space;
  if (space === null) return { known: false, reason: 'host_space_pending' };
  if (typeof space?.id !== 'string' || !SPACE_ID.test(space.id) || typeof space.providerId !== 'string' || !space.providerId) {
    return { known: false, reason: 'host_too_old' };
  }
  const formats = greeting.formats ?? {};
  return { known: true, spaceId: space.id, providerId: space.providerId,
    graphFormat: Number.isInteger(formats.graph) ? formats.graph : null,
    replicaProtocol: Number.isInteger(formats.replicaProtocol) ? formats.replicaProtocol : null };
}

// Asks the paired host once, for the preparation (follower-runtime-prepare.js).
// { known: false, reason: 'host_unreachable' } when it does not answer now.
export async function askHostSpace(dataDir, { ownFormats = null } = {}) {
  const store = new RunnerStore(join(dataDir, RUNNER_FILE));
  let connection = null;
  try {
    if (!store.host() || store.host().revokedAt) return { known: false, reason: 'host_unreachable' };
    connection = createHostConnection({ store, identity: await loadDeviceIdentity(join(dataDir, 'peer')),
      report: () => followerReport(ownFormats) });
    const greeting = await connection.hello();
    return greeting ? hostSpaceFrom(greeting) : { known: false, reason: 'host_unreachable' };
  } finally {
    connection?.close();
    store.close();
  }
}

// The headers of a follower's hello: its FULI version always, its graph's
// formats once its own Provider said them (the preparation keeps them).
export function followerReport(formats) {
  return {
    [FOLLOWER_VERSION_HEADER]: FULI_VERSION,
    ...(Number.isInteger(formats?.graph) ? { [FOLLOWER_GRAPH_FORMAT_HEADER]: String(formats.graph) } : {}),
    ...(Number.isInteger(formats?.replicaProtocol) ? { [FOLLOWER_REPLICA_PROTOCOL_HEADER]: String(formats.replicaProtocol) } : {})
  };
}
