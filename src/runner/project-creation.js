import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ApplicationError } from '../app/application-error.js';
import { installationRecord } from './project-installation.js';
import { gateDirectory, initializeProjectGate } from './project-write-gate.js';
import { RUNNER_PATHS } from './protocol.js';

const inFlight = new AsyncLocalStorage();
const unavailable = code => new ApplicationError(code, 'Project ownership could not be confirmed. 无法确认项目归属。', { status: 409 });
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// The rollout writes this local descriptor only after checking the space,
// registry and paired authority. A corrupt or partial descriptor fails closed.
export function projectRegistry(dataDir, spaceId) {
  const record = localRegistryDescriptor(dataDir);
  if (record && record.spaceId !== spaceId) throw unavailable('project_registry_unavailable');
  return record;
}

export function localRegistryDescriptor(dataDir) {
  let record;
  try { record = JSON.parse(readFileSync(join(dataDir, 'runner', 'project-registry.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw unavailable('project_registry_unavailable');
  }
  if (record?.version !== 1 || typeof record.spaceId !== 'string' || !record.spaceId || !fingerprint(record.device) || !fingerprint(record.authority)) {
    throw unavailable('project_registry_unavailable');
  }
  const phase = installationRecord(dataDir);
  if (!phase && record.projectMoves === 1) throw unavailable('project_registry_unavailable');
  if (phase && (phase.space !== record.spaceId || phase.device !== record.device || phase.authority !== record.authority)) {
    throw unavailable('project_registry_unavailable');
  }
  return phase?.phase === 'preparing' ? null : record;
}

// The peer certificate supplies the owner. No owner or grant comes from the
// request body. Reservations are bound to the active space and retry unchanged.
export function projectCreationDecision(store, spaceId, device, request) {
  if (request?.spaceId !== spaceId || !['reserve', 'confirm'].includes(request.action)) {
    return { ok: false, code: 'reservation_invalid' };
  }
  const registry = store.ownership();
  const result = registry[request.action](device, request.project, request.operation);
  return result.ok ? { ...result, spaceId } : result;
}

export function localProjectCreation(dataDir, spaceId, {
  descriptor = () => projectRegistry(dataDir, spaceId),
  identity = async () => {
    const { loadDeviceIdentity } = await import('../../packages/roundtable/src/peer/device-identity.js');
    return loadDeviceIdentity(join(dataDir, 'peer'));
  },
  paired = async use => {
    const { withHostConnection } = await import('./host-space.js');
    return withHostConnection(dataDir, {}, use);
  },
  openStore = async () => {
    const { RunnerHostStore, RUNNER_HOST_FILE } = await import('./host-store.js');
    return new RunnerHostStore(join(dataDir, RUNNER_HOST_FILE), { spaceId: () => spaceId });
  }
} = {}) {
  return async (project, write, completed = () => true) => {
    const parent = inFlight.getStore();
    if (parent?.active && parent.dataDir === dataDir && parent.spaceId === spaceId && parent.project === project) return write();
    const record = descriptor();
    if (!record) return write();
    const { device, authority } = record;
    if ((await identity()).fingerprint !== device) throw unavailable('project_registry_identity_changed');
    const operation = createHash('sha256').update(JSON.stringify([spaceId, device, project])).digest('hex');
    const store = await openStore();
    try {
      async function decide(action, operationId) {
        const request = { action, project, spaceId, operation: operationId };
        let result;
        if (authority === device) result = projectCreationDecision(store, spaceId, device, request);
        else {
          result = await paired(async ({ store: pairing, connection }) => {
            if (pairing.host()?.fingerprint !== authority) return null;
            const answer = await connection.postJson(RUNNER_PATHS.projectReservation, request);
            if (answer.status !== 200 || !answer.reachable || answer.revoked) return null;
            return answer.body;
          });
        }
        if (result && result.ok !== true) {
          const known = ['project_taken', 'project_conflict', 'inventory_incomplete', 'reservation_invalid', 'reservation_changed'];
          throw unavailable(known.includes(result.code) ? result.code : 'project_reservation_unavailable');
        }
        if (!result || result.spaceId !== spaceId || result.owner !== device || result.project !== project) {
          throw unavailable('project_reservation_unavailable');
        }
        if (authority !== device && !store.ownership().rememberPermit(authority, device, result).ok) {
          throw unavailable('project_reservation_changed');
        }
        return result;
      }
      const reserved = await decide('reserve', operation);
      initializeProjectGate(gateDirectory(dataDir, spaceId), project, 'owner', reserved.generation);
      // A follower installs the route in the outer operation. Its in-process
      // MCP upsert joins the reservation and cannot acknowledge prematurely.
      const context = { active: true, dataDir, spaceId, project };
      let value;
      try { value = await inFlight.run(context, write); } finally { context.active = false; }
      if (completed(value) && reserved.state !== 'owned') await decide('confirm', reserved.operation);
      return value;
    } finally { store.close(); }
  };
}

export function writeReservedProject(application, project, write, completed) {
  return application.projectCreation ? application.projectCreation(project, write, completed) : write();
}
