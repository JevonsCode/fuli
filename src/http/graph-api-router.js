import { readJson, sendJson } from './response.js';

export async function handleGraphApiRequest({ request, response, url, app }) {
  if (url.pathname === '/api/state' && request.method === 'GET') {
    sendJson(response, 200, await app.state());
    return true;
  }
  if (url.pathname === '/api/capture-policy' && request.method === 'GET') {
    sendJson(response, 200, app.getCapturePolicy());
    return true;
  }
  if (url.pathname === '/api/capture-policy' && request.method === 'PATCH') {
    sendJson(response, 200, app.updateCapturePolicy(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/agent-access-policy' && request.method === 'GET') {
    sendJson(response, 200, app.getAgentAccessPolicy());
    return true;
  }
  if (url.pathname === '/api/agent-access-policy' && request.method === 'PATCH') {
    sendJson(response, 200, app.updateAgentAccessPolicy(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/capture' && request.method === 'POST') {
    sendJson(response, 200, await app.captureSessionKnowledge(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/search' && request.method === 'GET') {
    sendJson(response, 200, await app.searchKnowledge({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      query: url.searchParams.get('q') ?? '',
      projectIds: url.searchParams.getAll('projectId'),
      personalProjectId: url.searchParams.get('personalProjectId'),
      contextPersonalProjectIds: url.searchParams.getAll('contextPersonalProjectId'),
      limit: numberParam(url, 'limit', 12),
      includeHistorical: url.searchParams.get('historical') === 'true',
      includePending: url.searchParams.get('pending') === 'true' ||
        url.searchParams.get('exploratory') === 'true'
    }));
    return true;
  }
  if (url.pathname === '/api/graph' && request.method === 'GET') {
    sendJson(response, 200, await app.getKnowledgeGraph({
      spaceId: url.searchParams.get('spaceId'),
      providerUrl: url.searchParams.get('providerUrl'),
      personalProjectId: url.searchParams.get('personalProjectId'),
      limit: numberParam(url, 'limit', 500),
      offset: nonNegativeNumberParam(url, 'offset', null)
    }));
    return true;
  }
  if (url.pathname === '/api/preference-conflicts' && request.method === 'GET') {
    sendJson(response, 200, await app.listPreferenceConflicts({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      status: url.searchParams.get('status'),
      limit: numberParam(url, 'limit', 500)
    }));
    return true;
  }
  if (
    url.pathname === '/api/preference-conflicts/defer'
    && request.method === 'POST'
  ) {
    sendJson(response, 200, await app.deferPreferenceConflict({
      ...(await readJson(request)),
      operationActor: 'human'
    }));
    return true;
  }
  const completedPreferenceConflict = url.pathname.match(
    /^\/api\/preference-conflicts\/([^/]+)\/complete$/
  );
  if (completedPreferenceConflict && request.method === 'POST') {
    sendJson(response, 200, await app.completePreferenceConflict({
      ...(await readJson(request)),
      conflictId: decodeURIComponent(completedPreferenceConflict[1]),
      operationActor: 'human'
    }));
    return true;
  }
  const assignment = url.pathname.match(
    /^\/api\/knowledge\/(entity|relationship)\/([^/]+)\/assignment$/
  );
  if (assignment && request.method === 'POST') {
    sendJson(response, 200, await app.reassignKnowledgeItem({
      ...(await readJson(request)),
      itemKind: assignment[1],
      itemId: decodeURIComponent(assignment[2]),
      operationActor: 'human'
    }));
    return true;
  }
  const preferenceScope = url.pathname.match(
    /^\/api\/knowledge\/(entity|relationship)\/([^/]+)\/preference-scope$/
  );
  if (preferenceScope && request.method === 'POST') {
    sendJson(response, 200, await app.setPersonalPreferenceScope({
      ...(await readJson(request)),
      itemKind: preferenceScope[1],
      itemId: decodeURIComponent(preferenceScope[2]),
      operationActor: 'human'
    }));
    return true;
  }
  const projectAction = url.pathname.match(
    /^\/api\/knowledge\/(entity)\/([^/]+)\/project-action(\/preview)?$/
  );
  if (projectAction && request.method === 'POST') {
    const body = await readJson(request);
    const input = {
      ...body,
      itemKind: projectAction[1],
      itemId: decodeURIComponent(projectAction[2]),
      operationActor: 'human'
    };
    const result = projectAction[3]
      ? await app.previewKnowledgeProjectAction(input)
      : await app.applyKnowledgeProjectAction(input);
    sendJson(response, 200, result);
    return true;
  }
  if (url.pathname === '/api/knowledge/batch-confirmation' && request.method === 'POST') {
    sendJson(
      response,
      200,
      await app.confirmKnowledgeBatch({
        ...(await readJson(request)),
        operationActor: 'human'
      })
    );
    return true;
  }
  const knowledgeItem = url.pathname.match(
    /^\/api\/knowledge\/(entity|relationship)\/([^/]+)$/
  );
  if (knowledgeItem && request.method === 'PATCH') {
    sendJson(response, 200, await app.reviseKnowledgeItem({
      ...(await readJson(request)),
      itemKind: knowledgeItem[1],
      itemId: decodeURIComponent(knowledgeItem[2]),
      operationActor: 'human'
    }));
    return true;
  }
  if (url.pathname === '/api/subscriptions' && request.method === 'POST') {
    sendJson(response, 200, await app.subscribePublicProject(await readJson(request)));
    return true;
  }
  const subscription = url.pathname.match(/^\/api\/subscriptions\/([^/]+)$/);
  if (subscription && request.method === 'DELETE') {
    sendJson(response, 200, await app.unsubscribePublicProject({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      projectId: decodeURIComponent(subscription[1]),
      providerUrl: url.searchParams.get('providerUrl')
    }));
    return true;
  }
  if (url.pathname === '/api/personal-projects' && request.method === 'GET') {
    sendJson(response, 200, await app.listPersonalProjects({
      personalSpaceId: url.searchParams.get('personalSpaceId')
    }));
    return true;
  }
  if (url.pathname === '/api/personal-projects' && request.method === 'PUT') {
    sendJson(response, 200, await app.upsertPersonalProject(await readJson(request)));
    return true;
  }
  if (url.pathname === '/api/projects/publish' && request.method === 'POST') {
    sendJson(response, 200, await app.publishPersonalProject(await readJson(request)));
    return true;
  }
  const projectReleases = url.pathname.match(/^\/api\/projects\/([^/]+)\/releases$/);
  if (projectReleases && request.method === 'GET') {
    sendJson(response, 200, await app.listProjectReleases({
      projectId: decodeURIComponent(projectReleases[1]),
      providerUrl: url.searchParams.get('providerUrl')
    }));
    return true;
  }
  const publicProject = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (publicProject && request.method === 'DELETE') {
    sendJson(response, 200, await app.deletePublicProject({
      projectId: decodeURIComponent(publicProject[1]),
      providerUrl: url.searchParams.get('providerUrl')
    }));
    return true;
  }
  if (url.pathname === '/api/project-relations' && request.method === 'GET') {
    sendJson(response, 200, await app.listProjectRelations({
      projectId: url.searchParams.get('projectId'),
      providerUrl: url.searchParams.get('providerUrl')
    }));
    return true;
  }
  if (url.pathname === '/api/project-relations' && request.method === 'POST') {
    sendJson(response, 200, await app.createProjectRelation(await readJson(request)));
    return true;
  }
  const relationDecision = url.pathname.match(
    /^\/api\/project-relations\/([^/]+)\/decision$/
  );
  if (relationDecision && request.method === 'POST') {
    const body = await readJson(request);
    sendJson(response, 200, await app.reviewProjectRelation({
      ...body,
      relationId: decodeURIComponent(relationDecision[1])
    }));
    return true;
  }
  if (url.pathname === '/api/personal-review' && request.method === 'GET') {
    sendJson(response, 200, await app.listPersonalReviewQueue({
      personalSpaceId: url.searchParams.get('personalSpaceId'),
      status: url.searchParams.get('status') ?? 'pending'
    }));
    return true;
  }
  const personalDecision = url.pathname.match(/^\/api\/personal-review\/([^/]+)\/decision$/);
  if (personalDecision && request.method === 'POST') {
    const body = await readJson(request);
    sendJson(response, 200, await app.reviewPersonalDraft({
      ...body,
      draftId: decodeURIComponent(personalDecision[1])
    }));
    return true;
  }
  if (url.pathname === '/api/review' && request.method === 'GET') {
    sendJson(response, 200, await app.listReviewQueue({
      projectId: url.searchParams.get('projectId'),
      providerUrl: url.searchParams.get('providerUrl'),
      status: url.searchParams.get('status') ?? 'pending'
    }));
    return true;
  }
  const decision = url.pathname.match(/^\/api\/review\/([^/]+)\/decision$/);
  if (decision && request.method === 'POST') {
    const body = await readJson(request);
    sendJson(response, 200, await app.reviewProposal({
      ...body,
      proposalId: decodeURIComponent(decision[1])
    }));
    return true;
  }
  if (url.pathname === '/api/graphiti/status' && request.method === 'GET') {
    sendJson(response, 200, await app.getGraphitiStatus());
    return true;
  }
  return false;
}

function numberParam(url, name, fallback) {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeNumberParam(url, name, fallback) {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return value;
}
