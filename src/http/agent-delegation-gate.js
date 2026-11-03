import { randomUUID } from 'node:crypto';

import { DELEGATION_HEADER, DELEGATION_OPERATION_HEADER, decodeDelegation } from '../agent-delegation/delegation-header.js';
import { mapHttpError } from './error-mapping.js';
import { isLoopbackAddress } from './request-policy.js';
import { sendJson } from './response.js';

// A console request an FLA makes for the person (run_delegated_action, rec#11
// D-81) carries DELEGATION_HEADER. It runs only from this computer, only for a
// route the interface catalog makes delegable, and only while the person keeps
// that category on; it is then handled like the person's own request and
// recorded with who made it, why and how to undo it. A request without the
// header is the person's and passes unchanged. handle() runs the API routes
// and answers whether one handled the request.
const CALLS = new WeakMap();

// The delegated call this gate accepted for a request; null for the person's own.
// A route that records who made a change reads it here, never from the header.
export function delegatedCall(request) {
  return CALLS.get(request) ?? null;
}

export async function handleDelegatedRequest({ request, response, delegation, agentAccessEnabled, handle }) {
  const header = request.headers[DELEGATION_HEADER];
  if (header === undefined) return handle();
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  let call;
  let entry;
  try {
    if (!isLoopbackAddress(request.socket?.remoteAddress)) {
      sendJson(response, 403, { error: 'Delegated changes are made only on this computer', code: 'local_user_only' });
      return true;
    }
    if (!delegation) {
      sendJson(response, 503, { error: 'AI permissions need a local FULI installation', code: 'delegation_unavailable' });
      return true;
    }
    call = decodeDelegation(header);
    entry = delegation.authorize(request.method, path, { agentAccessEnabled: agentAccessEnabled() });
  } catch (error) {
    const mapped = mapHttpError(error);
    sendJson(response, mapped.status, mapped.body);
    return true;
  }
  const id = randomUUID();
  response.setHeader(DELEGATION_OPERATION_HEADER, id);
  CALLS.set(request, call);
  let status;
  try {
    if (!await handle()) sendJson(response, 404, { error: 'No console route answers this request', code: 'not_found' });
    status = response.statusCode;
  } catch (error) {
    status = mapHttpError(error).status;
    throw error;
  } finally {
    delegation.record({ id, entry, path, call, status });
  }
  return true;
}
