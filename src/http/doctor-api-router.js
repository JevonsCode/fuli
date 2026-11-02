import { InvalidInputError } from '../app/application-error.js';
import { assertJsonObject } from '../validation/values.js';
import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

// FULI's 体检 (src/system/doctor.js) and the one-click move of an older
// install's Docker graph it points to (src/system/graph-migration.js). Reads
// are open to the console like any read; the repair writes client
// configuration and the migration restarts FULI, so only a request from this
// computer may start them (local_user_only in the interface catalog).

const DOCTOR_PATH = '/api/system/doctor';
const REPAIR_PATH = '/api/system/doctor/repair';
const MIGRATION_PATH = '/api/system/graph-migration';

export async function handleDoctorApiRequest({ request, response, url, system }) {
  const route = url.pathname === DOCTOR_PATH && system?.doctor ? { GET: () => system.doctor() }
    : url.pathname === REPAIR_PATH && system?.repairDoctor ? { POST: () => system.repairDoctor() }
      : url.pathname === MIGRATION_PATH && system?.startGraphMigration
        ? { GET: async () => ({ migration: system.graphMigration() }), POST: async () => ({ migration: system.startGraphMigration() }) }
        : null;
  if (!route) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (!route[request.method]) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (request.method === 'POST') {
    if (refuseRemoteDecision(request, response, 'FULI is repaired only on this computer')) return true;
    const body = await readJson(request);
    assertJsonObject(body, 'Doctor action');
    if (Object.keys(body).length) throw new InvalidInputError('This action takes no options; send {}.');
  }
  sendJson(response, 200, await route[request.method]());
  return true;
}
