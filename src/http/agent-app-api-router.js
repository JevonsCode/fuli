import { z } from 'zod';

import { ApplicationError } from '../app/application-error.js';
import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

const ROUTE = /^\/api\/agent-apps(?:\/([^/]+)(?:\/(approve|disable|rollback|delete-code|data-deletion|delete-data|start|stop|restart|confirm|export|reveal-export))?)?$/;
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
  'delete-data': z.object({ ticket: text.optional(), confirm: text.optional() }).strict(),
  start: z.object({}).strict(),
  stop: z.object({}).strict(),
  restart: z.object({}).strict(),
  confirm: z.object({ action: z.enum(['approve', 'rollback']), version }).strict(),
  export: z.object({}).strict(),
  'reveal-export': z.object({ path: z.string().min(1).max(1024) }).strict()
});
const CONSOLE_ACTIONS = new Set(['confirm', 'export', 'reveal-export']);

// Reads are open to the console. Writes approve, activate or remove Agent-written
// code. Normal Agent tools (MCP and fuli_call) have no route to them, and they
// are accepted only on loopback. Loopback and the repeated digest do not show that
// a person decided: any process of this OS account can call them, and the console
// request policy only stops cross-site web forgery. FULI records the decision as
// entrypoint http with presence unverified, and the run gate refuses the version
// it activates. The presence check exists only in `fuli app approve/rollback`.
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
  if (refuseRemoteDecision(request, response, 'Agent apps are managed only on this computer')) return true;
  const parsed = BODIES[action].safeParse(await readJson(request));
  if (!parsed.success) throw new TypeError('Invalid Agent app request');
  const body = parsed.data;
  const consoleActions = app.agentAppConsole;
  if (CONSOLE_ACTIONS.has(action) && !consoleActions) {
    throw new ApplicationError('app_console_unavailable', 'This step needs the local FULI console', { status: 409 });
  }
  const operations = {
    approve: () => agentApps.approve({ appId, version: body.version, digest: body.digest, approver: LOCAL_CONSOLE,
      confirmResident: body.confirmResident, confirmIrreversibleMigration: body.confirmIrreversibleMigration }),
    disable: () => agentApps.disable({ appId, actor: LOCAL_CONSOLE }),
    rollback: () => agentApps.rollback({ appId, version: body.version, actor: LOCAL_CONSOLE,
      confirmIrreversibleMigration: body.confirmIrreversibleMigration }),
    'delete-code': () => agentApps.deleteCode({ appId, actor: LOCAL_CONSOLE }),
    'data-deletion': () => agentApps.prepareDataDeletion({ appId }),
    'delete-data': () => agentApps.deleteData({ appId, ticket: body.ticket, confirm: body.confirm, actor: LOCAL_CONSOLE }),
    start: () => lifecycle(agentApps, appId, () => agentApps.start({ appId })),
    stop: () => lifecycle(agentApps, appId, () => agentApps.stop({ appId })),
    restart: () => lifecycle(agentApps, appId, async () => {
      await agentApps.stop({ appId });
      return agentApps.start({ appId });
    }),
    // A terminal window for the typed confirmation, the data copied into a new
    // folder FULI picks, and that folder shown (src/agent-apps/console-actions.js).
    confirm: () => consoleActions.confirmInTerminal({ appId, action: body.action, version: body.version }),
    export: () => consoleActions.exportData({ appId }),
    'reveal-export': () => consoleActions.revealExport({ appId, path: body.path })
  };
  sendJson(response, 200, await operations[action]());
  return true;
}

// Start, stop and restart from the console run the same instance lifecycle as
// a start on demand: the run gate decides, so a version approved only in the
// console is refused with the gate's own reason (confirmation_required,
// reconfirmation_required, challenge_mismatch, runner_check_failed) and the
// console shows the next step. A success answers with the instance as read() shows it.
async function lifecycle(agentApps, appId, run) {
  const outcome = await run();
  if (outcome?.status === 'run_refused') {
    throw new ApplicationError(outcome.reason, outcome.message, { status: 409 });
  }
  return { ...outcome, instance: agentApps.read({ appId }).instance };
}
