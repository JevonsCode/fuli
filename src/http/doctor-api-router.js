import { InvalidInputError } from '../app/application-error.js';
import { assertJsonObject } from '../validation/values.js';
import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

// FULI's 体检 (src/system/doctor.js). The read is open to the console like
// any read; the repair writes client configuration, so only a request from
// this computer may start it (local_user_only in the interface catalog).

const DOCTOR_PATH = '/api/system/doctor';
const REPAIR_PATH = '/api/system/doctor/repair';

export async function handleDoctorApiRequest({ request, response, url, system }) {
  if (!system?.doctor || (url.pathname !== DOCTOR_PATH && url.pathname !== REPAIR_PATH)) return false;
  response.setHeader('Cache-Control', 'no-store');
  const method = url.pathname === DOCTOR_PATH ? 'GET' : 'POST';
  if (request.method !== method) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (method === 'GET') {
    sendJson(response, 200, await system.doctor());
    return true;
  }
  if (refuseRemoteDecision(request, response, 'FULI is repaired only on this computer')) return true;
  const body = await readJson(request);
  assertJsonObject(body, 'Doctor repair');
  if (Object.keys(body).length) throw new InvalidInputError('A doctor repair takes no options; send {}.');
  sendJson(response, 200, await system.repairDoctor());
  return true;
}
