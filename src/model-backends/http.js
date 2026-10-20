import { sendJson } from '../http/response.js';

// Console read of the model usage ledger; the get_model_usage Agent tool
// reads the same port, so both share validation and output.
export async function handleModelBackendApiRequest({ request, response, url, modelBackends }) {
  if (url.pathname !== '/api/model-backends/usage') return false;
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }
  if (!modelBackends) {
    sendJson(response, 503, { error: 'Model backends need a local FULI installation' });
    return true;
  }
  response.setHeader('Cache-Control', 'no-store');
  sendJson(response, 200, modelBackends.usage({ role: url.searchParams.get('role'),
    from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
  return true;
}
