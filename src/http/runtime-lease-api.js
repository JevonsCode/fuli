import { readJson, sendJson } from './response.js';

export function isRuntimeLeasePath(path) {
  return path === '/api/system/runtime/leases' || path.startsWith('/api/system/runtime/leases/');
}

export async function handleRuntimeLease({ request, response, url, system }) {
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
  return false;
}

function decodeRuntimeLeaseId(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) throw new TypeError('Runtime lease ID is invalid');
    throw error;
  }
}
