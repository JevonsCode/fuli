import { readJson, sendJson } from './response.js';
import { handleLensRequest } from './lens-route.js';

export async function handleApiRequest({ request, response, app }) {
  const url = new URL(request.url, 'http://127.0.0.1');

  if (handleLensRequest({ request, response, url, app })) return true;

  if (url.pathname === '/api/state' && request.method === 'GET') {
    sendJson(response, 200, app.state());
    return true;
  }

  if (url.pathname === '/api/spaces' && request.method === 'POST') {
    const body = await readJson(request);
    const space = app.createSpace(body.name, body.kind, body.description ?? null);
    sendJson(response, 200, { space });
    return true;
  }

  if (url.pathname === '/api/bootstrap' && request.method === 'POST') {
    sendJson(response, 200, app.bootstrap());
    return true;
  }

  if (url.pathname === '/api/subscriptions' && request.method === 'POST') {
    const body = await readJson(request);
    const subscription = app.subscribe(
      body.personalSpaceId,
      body.spaceId,
      body.mode ?? 'latest'
    );
    sendJson(response, 200, { subscription });
    return true;
  }

  if (url.pathname === '/api/remember' && request.method === 'POST') {
    const body = await readJson(request);
    const result = app.remember({
      personalSpaceId: app.requireSpaceId({
        id: body.personalSpaceId,
        name: body.personalSpaceName,
        label: 'Personal space'
      }),
      targetSpaceId: optionalSpaceId(app, {
        id: body.targetSpaceId,
        name: body.targetSpaceName,
        label: 'Target space'
      }),
      sourceKind: body.sourceKind ?? 'agent',
      body: body.body,
      sourceUri: body.sourceUri ?? null
    });
    sendJson(response, 200, result);
    return true;
  }

  if (url.pathname === '/api/observe/git-diff' && request.method === 'POST') {
    const body = await readJson(request);
    const result = app.observe({
      personalSpaceId: body.personalSpaceId,
      targetSpaceId: body.targetSpaceId || null,
      cwd: body.cwd ?? process.cwd()
    });
    sendJson(response, 200, result);
    return true;
  }

  const candidateDecisionMatch = url.pathname.match(/^\/api\/candidates\/([^/]+)\/decision$/);
  if (candidateDecisionMatch && request.method === 'POST') {
    const body = await readJson(request);
    const candidate = app.decideCandidate(candidateDecisionMatch[1], body.decision);
    sendJson(response, 200, { candidate });
    return true;
  }

  if (url.pathname === '/api/search' && request.method === 'GET') {
    const result = app.search({
      personalSpaceId: requiredSpaceId(app, {
        id: url.searchParams.get('personalSpaceId'),
        name: url.searchParams.get('personalSpaceName'),
        label: 'Personal space'
      }),
      query: url.searchParams.get('q') ?? '',
      includeHistorical: url.searchParams.get('historical') === 'true'
    });
    sendJson(response, 200, result);
    return true;
  }

  if (url.pathname === '/api/context-pack' && request.method === 'GET') {
    const result = app.contextPack({
      personalSpaceId: requiredSpaceId(app, {
        id: url.searchParams.get('personalSpaceId'),
        name: url.searchParams.get('personalSpaceName'),
        label: 'Personal space'
      }),
      spaceId: requiredSpaceId(app, {
        id: url.searchParams.get('spaceId'),
        name: url.searchParams.get('spaceName'),
        label: 'Space'
      }),
      query: url.searchParams.get('q') ?? ''
    });
    sendJson(response, 200, result);
    return true;
  }

  return false;
}

function requiredSpaceId(app, input) {
  return app.requireSpaceId(input);
}

function optionalSpaceId(app, input) {
  if (!input.id && !input.name) return null;
  return requiredSpaceId(app, input);
}
