import { refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';

const LIST_PATH = '/api/agent-services';
const SERVICE_PATH = /^\/api\/agent-services\/([^/]+)(?:\/(log|stop))?$/;

// 服务管理 in the local console (rec#11 D-71): the services FULI Agents
// started with their live state, each one's log, and the person's own
// actions: stop a running service (the PID the dialog showed is sent back
// and must still be the recorded process), delete a record, clear a log.
// Loopback only, as the console is; Agents record their services through
// report_agent_service and have no route to these actions.
export async function handleAgentServicesRequest({ request, response, url, app }) {
  const service = url.pathname.match(SERVICE_PATH);
  if (url.pathname !== LIST_PATH && !service) return false;
  response.setHeader('Cache-Control', 'no-store');
  if (refuseRemoteDecision(request, response, 'Services are managed only on this computer')) return true;
  const services = app.agentServices;
  if (!services) {
    sendJson(response, 503, { error: 'Services need a local FULI installation', code: 'agent_services_unavailable' });
    return true;
  }
  const serviceId = service ? decodeURIComponent(service[1]) : null;
  const action = service?.[2] ?? null;
  const operation = {
    'GET list': () => services.list(),
    'GET log': () => services.log({ serviceId }),
    'POST stop': async () => services.stop({ serviceId, pid: (await readJson(request))?.pid }),
    'DELETE log': () => services.clearLog({ serviceId }),
    'DELETE service': () => services.remove({ serviceId })
  }[`${request.method} ${action ?? (service ? 'service' : 'list')}`];
  if (!operation) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  sendJson(response, 200, await operation());
  return true;
}
