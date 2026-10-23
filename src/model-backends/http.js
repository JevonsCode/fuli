import { refuseRemoteDecision } from '../http/request-policy.js';
import { readJson, sendJson } from '../http/response.js';

// Routes of the model settings page. The roles and usage reads are
// Agent-readable and contain no secrets, but include metadata (endpoints,
// prices, approved projects); get_model_usage reads the same port. Saving one
// role is accepted only at the local process boundary (a loopback request).
// That does not show a person sent it and is not the human-review channel:
// no MCP or Agent tool calls it, but anything with local shell or HTTP access
// can. Keys stay a local command (fuli models set-key).
// operations: the task types each role already sends to its model.
// TODO(#283): once the Tonborg review gate merges, add tonborg's reviewGate
// status here; the console shows it read-only when present.
const ROLE_ROUTE = /^\/api\/model-backends\/roles\/([a-z]+)$/;

export async function handleModelBackendApiRequest({
  request, response, url, modelBackends, roleWork = null, roleSettings = null, operations = {}
}) {
  const roleEdit = ROLE_ROUTE.exec(url.pathname)?.[1] ?? null;
  if (!roleEdit && !['/api/model-backends/usage', '/api/model-backends/roles'].includes(url.pathname)) return false;
  if (request.method !== (roleEdit ? 'PUT' : 'GET')) {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (!modelBackends || (roleEdit && !roleSettings)) {
    sendJson(response, 503, { error: 'Model backends need a local FULI installation' });
    return true;
  }
  response.setHeader('Cache-Control', 'no-store');
  if (roleEdit) {
    if (refuseRemoteDecision(request, response, 'Model settings are changed only on this computer')) return true;
    roleSettings.save(roleEdit, await readJson(request));
  }
  if (roleEdit || url.pathname === '/api/model-backends/roles') {
    sendJson(response, 200, { ...modelBackends.roles(), operations, workPackages: roleWork?.summary().packages ?? [] });
    return true;
  }
  sendJson(response, 200, modelBackends.usage({ role: url.searchParams.get('role'),
    from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
  return true;
}
