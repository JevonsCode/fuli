import { isLoopbackAddress, refuseRemoteDecision } from './request-policy.js';
import { readJson, sendJson } from './response.js';
import { handleExternalKnowledgeApiRequest } from './external-knowledge-api-router.js';
import { handleGraphApiRequest } from './graph-api-router.js';
import { handleEmployeeApiRequest } from './employee-api-router.js';
import { handleAgentAppApiRequest } from './agent-app-api-router.js';
import { handleDataFormatApiRequest } from './data-format-api-router.js';
import { handleDoctorApiRequest } from './doctor-api-router.js';
import { handleDiagnosticsApiRequest } from './diagnostics-api-router.js';
import { handleSessionLaunchRequest } from './session-launch-api-router.js';
import { handleKnowledgeHardDeleteRequest } from './knowledge-hard-delete-api-router.js';
import { handleKnowledgeScopeRequest } from './knowledge-scope-api-router.js';
import { handleProjectHierarchyRequest } from './project-hierarchy-api-router.js';
import { handleTaskBlockerRequest } from './task-blocker-api-router.js';
import { handleKnowledgeTagsRequest } from './knowledge-tags-api-router.js';
import { handleStandingAssignmentRequest } from './standing-assignment-api-router.js';
import { handleClientLinksRequest } from './client-links-api-router.js';
import { handleAgentServicesRequest } from './agent-services-api-router.js';
import { handleAgentWorkflowsRequest } from './agent-workflows-api-router.js';
import { handleRoundtableApiRequest } from '../agent-roundtable/http.js';
import { handlePeerApiRequest } from '../agent-peer/http.js';
import { handleJudgmentApiRequest } from '../judgment/http.js';
import { handleModelBackendApiRequest } from '../model-backends/http.js';
import { handleModelKeyRequest } from '../model-backends/keys-http.js';
import { TONBORG_OPERATIONS } from '../judgment/backend.js';
import { ASTRO_OPERATION } from '../graphiti/assistant-project-candidate.js';
import { JEFA_OPERATION } from '../graphiti/jefa-board-match.js';
import { FULI_VERSION } from '../package-metadata.js';

const MODEL_SUGGESTIONS_PATH = '/api/model-backends/suggestions';

export async function handleApiRequest({
  request,
  response,
  app,
  system = null,
  externalKnowledge = null,
  connectedKnowledge = null,
  peer = null,
  dataFormats = null,
  dataFormatMigrations = null,
  knowledgeHardDelete = null,
  knowledgeScope = null,
  projectHierarchy = null,
  taskBlockers = null,
  knowledgeOwnerReads = null,
  knowledgeTags = null,
  modelRoleSettings = null,
  modelSecrets = null,
  readModelEvaluation = null,
  judgmentUndo = null,
  clientLinks = null
}) {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (await handlePeerApiRequest({ request, response, url, peer })) return true;
  if (await handleModelKeyRequest({ request, response, url, secrets: modelSecrets })) return true;
  if (await handleClientLinksRequest({ request, response, url, clientLinks })) return true;
  if (await handleRoundtableApiRequest({ request, response, url, roundtable: app.roundtable })) return true;
  if (await handleAgentAppApiRequest({ request, response, url, app })) return true;
  const modelBackendRequest = () => handleModelBackendApiRequest({ request, response, url, modelBackends: app.modelBackends, roleWork: app.roleWork,
    readRoleSuggestions: app.roleSuggestions ? input => app.readRoleSuggestions(input) : null,
    roleSettings: modelRoleSettings, operations: { assistant: [ASTRO_OPERATION], jefa: [JEFA_OPERATION], tonborg: Object.values(TONBORG_OPERATIONS) },
    automaticOperations: { tonborg: TONBORG_OPERATIONS.review }, modelTrust: app.modelTrust ?? null,
    settingsHistory: app.modelSettingsHistory ?? null, readEvaluation: readModelEvaluation,
    ownerReads: knowledgeOwnerReads, personalSpaceId: app.config?.personal?.spaceId ?? null });
  // The suggestion log's owner proof is confirmed with the Provider, so that
  // read wakes an adaptive runtime like any graph request (rec#11 D-60).
  if (system?.withGraphRuntimeLease && url.pathname === MODEL_SUGGESTIONS_PATH
    ? await system.withGraphRuntimeLease(`http:${request.method}:${url.pathname}`, modelBackendRequest)
    : await modelBackendRequest()) return true;

  if (url.pathname === '/api/health' && request.method === 'GET') {
    sendJson(response, 200, {
      status: 'ready',
      service: 'fuli-local-console',
      pid: process.pid,
      version: FULI_VERSION,
      // Local stores this FULI cannot use as they are (rec#17), by store and step.
      ...(dataFormats ? { dataFormats: dataFormats() } : {})
    });
    return true;
  }

  if (system && url.pathname === '/api/system/settings' && request.method === 'GET') {
    response.setHeader('Cache-Control', 'no-store');
    sendJson(response, 200, system.getSettings());
    return true;
  }

  if (system && url.pathname === '/api/system/client-connection' && request.method === 'GET') {
    response.setHeader('Cache-Control', 'no-store');
    sendJson(response, 200, system.clientConnection());
    return true;
  }

  if (system && url.pathname === '/api/system/client-connection/connect' && request.method === 'POST') {
    response.setHeader('Cache-Control', 'no-store');
    if (!isLoopbackAddress(request.socket?.remoteAddress)) {
      sendJson(response, 403, { error: 'Client connection is only available on this computer' });
      return true;
    }
    sendJson(response, 200, await system.connectClient(await readJson(request)));
    return true;
  }

  if (system && url.pathname === '/api/system/client-connection/status' && request.method === 'GET') {
    response.setHeader('Cache-Control', 'no-store');
    sendJson(response, 200, system.clientConnectionStatus());
    return true;
  }

  if (system && url.pathname === '/api/system/settings' && request.method === 'PUT') {
    const result = await system.updateSettings(await readJson(request));
    if (result.apply?.status === 'applying') {
      // Flush the acknowledgement before the detached worker stops this server.
      let started = false;
      const start = () => {
        if (started) return;
        started = true;
        system.startSettingsApply(result.apply.id);
      };
      response.once('finish', start);
      response.once('close', start);
    }
    sendJson(response, 200, result);
    return true;
  }

  // An image load can confirm readiness across a console port change without
  // granting another origin access to authenticated JSON or widening CORS.
  if (system && url.pathname === '/api/system/settings/ready.svg' && request.method === 'GET') {
    const apply = system.settingsApplyStatus?.();
    response.setHeader('Cache-Control', 'no-store');
    if (apply?.id !== url.searchParams.get('id') || apply.status !== 'applied') {
      sendJson(response, 503, { error: 'Settings are not ready' });
      return true;
    }
    response.writeHead(200, { 'content-type': 'image/svg+xml', 'x-content-type-options': 'nosniff' });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    return true;
  }

  if (system && url.pathname === '/api/system/resources' && request.method === 'GET') {
    sendJson(response, 200, await system.resources());
    return true;
  }

  // ?cached=1 answers from the checker's last answer and never waits on npm.
  if (system && url.pathname === '/api/system/version' && request.method === 'GET') {
    sendJson(response, 200, url.searchParams.get('cached') === '1'
      ? system.cachedVersionStatus() : await system.versionStatus());
    return true;
  }

  // The console's own update (src/system/console-update.js): its state, and
  // the start, which only a request from this computer may make.
  if (system?.startUpdate && url.pathname === '/api/system/update') {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET') sendJson(response, 200, { update: system.updateStatus() });
    else if (request.method !== 'POST') sendJson(response, 405, { error: 'Method not allowed' });
    else if (!refuseRemoteDecision(request, response, 'FULI is updated only on this computer')) {
      const { stopProcesses } = await readJson(request);
      sendJson(response, 200, await system.startUpdate({ stopProcesses }));
    }
    return true;
  }

  // Outside the graph runtime lease: polling the doctor never wakes a
  // sleeping provider (its graph format plan then reads as unavailable).
  if (await handleDoctorApiRequest({ request, response, url, system })) return true;
  if (await handleDiagnosticsApiRequest({ request, response, url, app, system })) return true;
  if (await handleSessionLaunchRequest({ request, response, url, system })) return true;

  if (system && url.pathname === '/api/system/runtime' && request.method === 'GET') {
    sendJson(response, 200, system.runtimeStatus());
    return true;
  }

  if (system && url.pathname === '/api/system/runtime/leases' && request.method === 'POST') {
    const lease = await system.acquireRuntimeLease(await readJson(request));
    if (response.destroyed) {
      // Startup can outlive the caller's timeout. No recipient can now renew/release this handle.
      if (lease.leaseId) system.releaseRuntimeLease(lease.leaseId);
      return true;
    }
    sendJson(response, 201, lease);
    return true;
  }

  const runtimeLease = url.pathname.match(/^\/api\/system\/runtime\/leases\/([^/]+)$/);
  if (system && runtimeLease && request.method === 'PATCH') {
    sendJson(
      response,
      200,
      system.refreshRuntimeLease(decodeRuntimeLeaseId(runtimeLease[1]))
    );
    return true;
  }
  if (system && runtimeLease && request.method === 'DELETE') {
    sendJson(
      response,
      200,
      system.releaseRuntimeLease(decodeRuntimeLeaseId(runtimeLease[1]))
    );
    return true;
  }

  const externalRequest = () => handleExternalKnowledgeApiRequest({
    request, response, url, externalKnowledge, connectedKnowledge
  });
  const handledExternal = system?.withGraphRuntimeLease &&
    externalRequestNeedsGraph(url.pathname, request.method)
    ? await system.withGraphRuntimeLease(
        `http:${request.method}:${url.pathname}`,
        externalRequest
      )
    : await externalRequest();
  if (handledExternal) return true;

  // Data format routes run under the graph runtime lease like any graph
  // request: an adaptive runtime wakes the provider for a preview and keeps
  // it up through a long apply or undo.
  const graphRequest = async () =>
    await handleDataFormatApiRequest({ request, response, url, migrations: dataFormatMigrations }) ||
    await handleKnowledgeHardDeleteRequest({ request, response, url, app, hardDelete: knowledgeHardDelete }) ||
    await handleKnowledgeScopeRequest({ request, response, url, app, scopeConsole: knowledgeScope }) ||
    await handleProjectHierarchyRequest({ request, response, url, app, hierarchyConsole: projectHierarchy }) ||
    await handleTaskBlockerRequest({ request, response, url, app, blockerConsole: taskBlockers }) ||
    await handleKnowledgeTagsRequest({ request, response, url, app, tagsConsole: knowledgeTags }) ||
    await handleJudgmentApiRequest({ request, response, url, app, undoConsole: judgmentUndo, ownerReads: knowledgeOwnerReads }) ||
    await handleStandingAssignmentRequest({ request, response, url, app }) ||
    await handleAgentServicesRequest({ request, response, url, app }) ||
    await handleAgentWorkflowsRequest({ request, response, url, app }) ||
    await handleEmployeeApiRequest({ request, response, url, app }) ||
    await handleGraphApiRequest({ request, response, url, app, ownerReads: knowledgeOwnerReads });
  if (system?.withGraphRuntimeLease && (
    url.pathname.startsWith('/api/') || url.pathname.startsWith('/employee-workspaces/')
  )) {
    return system.withGraphRuntimeLease(
      `http:${request.method}:${url.pathname}`,
      graphRequest
    );
  }
  return graphRequest();
}

function decodeRuntimeLeaseId(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) throw new TypeError('Runtime lease ID is invalid');
    throw error;
  }
}

function externalRequestNeedsGraph(pathname, method) {
  if (pathname === '/api/connected-knowledge/search' && method === 'POST') return true;
  if (pathname === '/api/external-knowledge/bindings' && method === 'POST') return true;
  if (
    /^\/api\/external-knowledge\/bindings\/[^/]+\/sync$/.test(pathname) &&
    method === 'POST'
  ) return true;
  if (
    /^\/api\/external-knowledge\/bindings\/[^/]+\/targets$/.test(pathname) &&
    method === 'PATCH'
  ) return true;
  return /^\/api\/external-knowledge\/bindings\/[^/]+$/.test(pathname) &&
    method === 'DELETE';
}
