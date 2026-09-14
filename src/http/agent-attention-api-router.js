import { readJson, sendJson } from './response.js';

export async function handleAgentAttentionRequest({ request, response, url, app }) {
  if (url.pathname === '/api/agent-attention' && request.method === 'GET') {
    sendJson(response, 200, await app.listAgentAttention({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      personalProjectId: url.searchParams.get('personalProjectId'),
      agentId: url.searchParams.get('agentId'),
      status: url.searchParams.get('status') ?? 'open',
      limit: Number(url.searchParams.get('limit') ?? 100),
      offset: Number(url.searchParams.get('offset') ?? 0)
    }));
    return true;
  }
  if (url.pathname === '/api/agent-attention' && request.method === 'POST') {
    sendJson(response, 200, await app.requestAgentAttention(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/agent-attention/cancel' && request.method === 'POST') {
    sendJson(response, 200, await app.cancelAgentAttention(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/agent-attention/respond' && request.method === 'POST') {
    sendJson(response, 200, await app.respondToAgentAttention(await readJson(request)));
    return true;
  }
  return false;
}
