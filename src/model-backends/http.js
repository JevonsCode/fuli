import { sendJson } from '../http/response.js';

// Console reads for Settings: each role's backend and the usage ledger. The
// get_model_usage Agent tool reads the same port, so both share validation
// and output. Configuration stays a local file and keys a local command.
export async function handleModelBackendApiRequest({ request, response, url, modelBackends, roleWork = null }) {
  if (!['/api/model-backends/usage', '/api/model-backends/roles'].includes(url.pathname)) return false;
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (!modelBackends) {
    sendJson(response, 503, { error: 'Model backends need a local FULI installation' });
    return true;
  }
  response.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/api/model-backends/roles') {
    sendJson(response, 200, { ...modelBackends.roles(), workPackages: roleWork?.summary().packages ?? [] });
    return true;
  }
  sendJson(response, 200, modelBackends.usage({ role: url.searchParams.get('role'),
    from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
  return true;
}
