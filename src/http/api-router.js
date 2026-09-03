import { readJson, sendJson } from './response.js';
import { handleExternalKnowledgeApiRequest } from './external-knowledge-api-router.js';
import { handleGraphApiRequest } from './graph-api-router.js';
import { handleEmployeeApiRequest } from './employee-api-router.js';

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

  if (system && url.pathname === '/api/system/version' && request.method === 'GET') {
    sendJson(response, 200, await system.versionStatus());
    return true;
  }

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

  const graphRequest = async () =>
    await handleEmployeeApiRequest({ request, response, url, app }) ||
    await handleGraphApiRequest({ request, response, url, app });
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
