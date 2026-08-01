import { readJson, sendJson } from './response.js';
import { handleExternalKnowledgeApiRequest } from './external-knowledge-api-router.js';
import { handleGraphApiRequest } from './graph-api-router.js';

export async function handleApiRequest({
  request,
  response,
  app,
  system = null,
  externalKnowledge = null,
  connectedKnowledge = null
}) {
  const url = new URL(request.url, 'http://127.0.0.1');

  if (url.pathname === '/api/health' && request.method === 'GET') {
    sendJson(response, 200, {
      status: 'ready',
      service: 'fuli-local-console',
      pid: process.pid
    });
    return true;
  }

  if (system && url.pathname === '/api/system/settings' && request.method === 'GET') {
    sendJson(response, 200, system.getSettings());
    return true;
  }

  if (system && url.pathname === '/api/system/settings' && request.method === 'PUT') {
    sendJson(response, 200, system.updateSettings(await readJson(request)));
    return true;
  }

  if (system && url.pathname === '/api/system/resources' && request.method === 'GET') {
    sendJson(response, 200, await system.resources());
    return true;
  }

  if (await handleExternalKnowledgeApiRequest({
    request,
    response,
    url,
    externalKnowledge,
    connectedKnowledge
  })) return true;

  return handleGraphApiRequest({ request, response, url, app });
}
