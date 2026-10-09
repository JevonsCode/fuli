import { readJson, sendJson } from '../http/response.js';

const owner = Object.freeze({ kind: 'owner' });

// The parent local-console request policy must authorize the owner before entry.
export async function handleRoundtableApiRequest({ request, response, url, service }) {
  if (!service || !url.pathname.startsWith('/api/roundtables')) return false;
  if (url.pathname === '/api/roundtables') {
    if (request.method === 'GET') sendJson(response, 200, await service.list({}, owner));
    else if (request.method === 'POST') {
      const input = await readJson(request);
      if (service.bindingAuthority !== 'fuli_application' &&
          (input.binding || input.projectPath || input.personalProjectId || (input.seats ?? []).some((seat) => seat.agentId || seat.shareAgentContext))) {
        throw new TypeError('Standalone rooms cannot claim a Fuli project or Agent; connect the validated Fuli application');
      }
      sendJson(response, 201, await service.create(input, owner));
    }
    else sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  const route = url.pathname.match(/^\/api\/roundtables\/([^/]+)(?:\/(control|messages|invites|revoke))?$/);
  if (!route) { sendJson(response, 404, { error: 'Roundtable route not found' }); return true; }
  const roomId = decodeURIComponent(route[1]);
  if (!route[2] && request.method === 'GET') {
    const after = Number(url.searchParams.get('after') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    sendJson(response, 200, await service.read({ roomId, after, limit }, owner));
  } else if (route[2] && request.method === 'POST') {
    const methods = { control: 'control', messages: 'addHumanMessage', invites: 'invite', revoke: 'revoke' };
    const body = await readJson(request);
    const { actor: _actor, taskVerification: _fakeVerification, ...safe } = body;
    sendJson(response, 200, await service[methods[route[2]]]({ ...safe, roomId }, owner));
  } else sendJson(response, 405, { error: 'Method not allowed' });
  return true;
}

export async function handleRoundtablePeerRequest({ request, response, url, service }) {
  const route = url.pathname.match(/^\/roundtable-peer\/v1\/rooms\/([^/]+)\/(discover|read|join|claim|submit|message)$/);
  if (!route) return false;
  const roomId = decodeURIComponent(route[1]);
  const actor = service.authenticate({ roomId, seatToken: bearerToken(request),
    sourceApplication: 'other', sourceSessionId: 'remote-capability' });
  if (request.method !== 'POST' || !request.headers['content-type']?.startsWith('application/json')) {
    sendJson(response, 415, { error: 'POST application/json required' }); return true;
  }
  const body = await readJson(request);
  const { actor: _actor, seatToken: _secret, seatId: _seat, senderSeatId: _senderSeat,
    sourceApplication: _source, sourceSessionId: _session, ...safe } = body;
  const methods = { discover: 'discover', read: 'read', join: 'join', claim: 'claim', submit: 'submit', message: 'message' };
  sendJson(response, 200, await service[methods[route[2]]]({ ...safe, roomId }, actor));
  return true;
}

export function bearerToken(request) {
  const match = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{20,512})$/);
  if (!match) throw Object.assign(new Error('Seat invitation required'), { status: 401, code: 'roundtable_unauthorized' });
  return match[1];
}
