import { z } from 'zod';

import { ApplicationError } from '../app/application-error.js';
import { isLoopbackAddress } from './request-policy.js';
import { readJson, sendJson } from './response.js';

const ROUTE = /^\/api\/agent-apps(?:\/([^/]+)(?:\/(approve|disable|rollback|delete-code|data-deletion|delete-data))?)?$/;
const LOCAL_CONSOLE = Object.freeze({ entrypoint: 'http', user: 'local-console' });
const version = z.string().min(1).max(32);
const text = z.string().max(128);
const BODIES = Object.freeze({
  approve: z.object({ version, digest: text, confirmResident: z.boolean().optional(),
    confirmIrreversibleMigration: z.boolean().optional() }).strict(),
  disable: z.object({}).strict(),
  rollback: z.object({ version, confirmIrreversibleMigration: z.boolean().optional() }).strict(),
  'delete-code': z.object({}).strict(),
  'data-deletion': z.object({}).strict(),
  'delete-data': z.object({ ticket: text.optional(), confirm: text.optional() }).strict()
});

// Reads are open to the console. Writes approve, activate or remove Agent-written
// code. Normal Agent tools (MCP and fuli_call) have no route to them, and they
// are accepted only on loopback. Loopback and the repeated digest do not show that
// a person decided: any process of this OS account can call them, and the console
// request policy only stops cross-site web forgery. FULI records the decision as
// entrypoint http with presence unverified.
export async function handleAgentAppApiRequest({ request, response, url, app }) {
  const route = url.pathname.match(ROUTE);
  if (!route) return false;
  const [, appId, action] = route;
  const agentApps = app.agentApps;
  if (!agentApps) throw new ApplicationError('agent_apps_unavailable', 'Agent apps need a local FULI installation', { status: 503 });
  if (request.method === 'GET' && !action) {
    sendJson(response, 200, appId ? agentApps.read({ appId }) : agentApps.list({
      personalSpaceId: url.searchParams.get('personalSpaceId'), agentId: url.searchParams.get('agentId')
    }));
    return true;
  }
  if (request.method !== 'POST' || !action) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (!isLoopbackAddress(request.socket?.remoteAddress)) {
    sendJson(response, 403, { error: 'Agent apps are managed only on this computer', code: 'local_user_only' });
    return true;
  }
  const parsed = BODIES[action].safeParse(await readJson(request));
  if (!parsed.success) throw new TypeError('Invalid Agent app request');
  const body = parsed.data;
  const operations = {
    approve: () => agentApps.approve({ appId, version: body.version, digest: body.digest, approver: LOCAL_CONSOLE,
      confirmResident: body.confirmResident, confirmIrreversibleMigration: body.confirmIrreversibleMigration }),
    disable: () => agentApps.disable({ appId, actor: LOCAL_CONSOLE }),
    rollback: () => agentApps.rollback({ appId, version: body.version, actor: LOCAL_CONSOLE,
      confirmIrreversibleMigration: body.confirmIrreversibleMigration }),
    'delete-code': () => agentApps.deleteCode({ appId, actor: LOCAL_CONSOLE }),
    'data-deletion': () => agentApps.prepareDataDeletion({ appId }),
    'delete-data': () => agentApps.deleteData({ appId, ticket: body.ticket, confirm: body.confirm, actor: LOCAL_CONSOLE })
  };
  sendJson(response, 200, operations[action]());
  return true;
}
