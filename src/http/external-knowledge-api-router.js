import { readJson, sendJson } from './response.js';

export async function handleExternalKnowledgeApiRequest({
  request,
  response,
  url,
  externalKnowledge,
  connectedKnowledge
}) {
  if (!externalKnowledge && !connectedKnowledge) return false;

  if (externalKnowledge &&
      url.pathname === '/api/external-knowledge/connectors' &&
      request.method === 'GET') {
    sendJson(response, 200, externalKnowledge.listConnectorTypes());
    return true;
  }
  if (externalKnowledge &&
      url.pathname === '/api/external-knowledge/discover' &&
      request.method === 'POST') {
    sendJson(response, 200, await externalKnowledge.discover(await readJson(request)));
    return true;
  }
  if (externalKnowledge &&
      url.pathname === '/api/external-knowledge/bindings' &&
      request.method === 'GET') {
    sendJson(response, 200, await externalKnowledge.listBindings());
    return true;
  }
  if (externalKnowledge &&
      url.pathname === '/api/external-knowledge/bindings' &&
      request.method === 'POST') {
    sendJson(response, 201, await externalKnowledge.createBinding(await readJson(request)));
    return true;
  }

  const action = url.pathname.match(
    /^\/api\/external-knowledge\/bindings\/([^/]+)\/(check|sync|retrieve)$/
  );
  if (externalKnowledge && action && request.method === 'POST') {
    const id = decodeURIComponent(action[1]);
    const body = await readJson(request);
    const result = action[2] === 'check'
      ? await externalKnowledge.checkBinding(id)
      : action[2] === 'sync'
        ? await externalKnowledge.syncBinding(id, body)
        : await externalKnowledge.retrieveBinding(id, body);
    sendJson(response, 200, result);
    return true;
  }

  const targets = url.pathname.match(
    /^\/api\/external-knowledge\/bindings\/([^/]+)\/targets$/
  );
  if (externalKnowledge && targets && request.method === 'PATCH') {
    sendJson(
      response,
      200,
      await externalKnowledge.updateBindingTargets(
        decodeURIComponent(targets[1]),
        await readJson(request)
      )
    );
    return true;
  }

  const binding = url.pathname.match(
    /^\/api\/external-knowledge\/bindings\/([^/]+)$/
  );
  if (externalKnowledge && binding && request.method === 'DELETE') {
    sendJson(
      response,
      200,
      await externalKnowledge.deleteBinding(decodeURIComponent(binding[1]))
    );
    return true;
  }

  if (connectedKnowledge &&
      url.pathname === '/api/external-knowledge/conflict-policy' &&
      request.method === 'GET') {
    sendJson(response, 200, connectedKnowledge.getConflictPolicy({
      personalProjectId: url.searchParams.get('personalProjectId')
    }));
    return true;
  }
  if (connectedKnowledge &&
      url.pathname === '/api/external-knowledge/conflict-policy' &&
      request.method === 'PATCH') {
    sendJson(
      response,
      200,
      await connectedKnowledge.updateConflictPolicy(await readJson(request))
    );
    return true;
  }
  if (connectedKnowledge &&
      url.pathname === '/api/connected-knowledge/search' &&
      request.method === 'POST') {
    sendJson(response, 200, await connectedKnowledge.query(await readJson(request)));
    return true;
  }
  return false;
}
