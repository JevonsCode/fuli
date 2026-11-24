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
const HEALTH_MS = 3000;

// The host's side: what its hello adds, read once from its own graph runtime
// (the space from its settings, provider_id and formats from its Provider's
// health) and kept, since they change only with a new start. null while its
// Provider does not answer; the next hello asks again.
export function hostSpaceReader(app, { timeoutMs = HEALTH_MS } = {}) {
  let known = null;
  return async () => {
    if (known) return known;
    const spaceId = app?.config?.personal?.spaceId;
    if (typeof spaceId !== 'string' || typeof app.personal?.health !== 'function') return null;
    try {
      const health = await Promise.race([app.personal.health(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('health timeout')), timeoutMs).unref?.())]);
      if (typeof health?.providerId !== 'string') return null;
      known = { space: { id: spaceId, providerId: health.providerId },
        formats: { graph: health.data_format?.supported_version ?? null, replicaProtocol: health.replicaProtocol ?? null } };
    } catch { return null; }
    return known;
  };
}

// The follower's side: what one hello said of the host's space.
//   { known: true, spaceId, providerId, graphFormat, replicaProtocol }
//   { known: false, reason: 'host_too_old' }: the host answered without it
export function hostSpaceFrom(greeting) {
  const space = greeting?.space;
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
