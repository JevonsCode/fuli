import { localRegistryDescriptor } from './project-creation.js';
import { RUNNER_PATHS } from './protocol.js';
import { grantScope } from './scope-grants.js';

export const FOLLOWER_TRANSFER = '/__fuli-follower/project-transfer';

export function transferPair(dataDir, store) {
  const descriptor = localRegistryDescriptor(dataDir);
  if (!descriptor || descriptor.projectMoves !== 1 || descriptor.device === descriptor.authority) return null;
  const pairing = store.projectPairing(descriptor.authority);
  return pairing ? { ...descriptor, pairing } : null;
}

// The paired host authenticates this device. The caller cannot choose another
// network path, space, pairing, or a third device as a transfer endpoint.
export async function followerTransfer({ pair, connection, input, relayed }) {
  if (!pair) return { status: 409, body: { code: 'move_pairing_changed' } };
  let path, body;
  if (input?.action === 'follow' && grantScope(input.scope)) {
    path = RUNNER_PATHS.scopeRequest;
    body = { scope: input.scope, spaceId: pair.spaceId };
  } else if (['start', 'status', 'cancel'].includes(input?.action) && typeof input.project === 'string' &&
      grantScope('project:' + input.project) && typeof input.moveId === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(input.moveId)) {
    path = RUNNER_PATHS.moveControl;
    body = { action: input.action, project: input.project, moveId: input.moveId, pairing: pair.pairing, spaceId: pair.spaceId };
    if (input.action === 'start') {
      if (!['here', 'host', pair.device, pair.authority].includes(input.target) || typeof input.reason !== 'string' ||
          !input.reason.trim() || input.reason.length > 2000) return { status: 400, body: { code: 'move_invalid' } };
      Object.assign(body, { reason: input.reason, relayed, target: input.target === 'here' ? pair.device :
        input.target === 'host' ? pair.authority : input.target });
    }
  } else return { status: 400, body: { code: 'move_invalid' } };
  const result = await connection.postJson(path, body, { maxBytes: 8192 });
  return result.reachable ? { status: result.status, body: result.body } :
    { status: 503, body: { code: result.timedOut ? 'owner_result_unknown' : 'owner_offline' } };
}
