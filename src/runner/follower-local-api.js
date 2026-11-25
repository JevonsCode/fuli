import { setTimeout as delay } from 'node:timers/promises';

import { globalCopyRefusal, localGraphRequestNeedsGlobal } from './global-copy-access.js';
import { mapHttpError } from '../http/error-mapping.js';
import { guardJsonResponse, sendJson } from '../http/response.js';
import { handleRuntimeLease, isRuntimeLeasePath } from '../http/runtime-lease-api.js';
import { FOLLOWER_GRAPH_PATH, FOLLOWER_FORMAT_PATH } from './follower-maintenance-paths.js';
import { RUNNER_PATHS } from './protocol.js';

async function openLocalApplication(options) {
  const { openFederatedGraphApplication } = await import('../graphiti/federated-application.js');
  return openFederatedGraphApplication(options);
}

// How long the merged project list waits for this computer's part: the host's projects are not
// held back by a runtime that is waking or cannot start.
export const LOCAL_LIST_WAIT_MS = 3_000;

export function createFollowerLocalApi({ paths, store, connection, broker, globalWrites, open = openLocalApplication,
  localListWaitMs = LOCAL_LIST_WAIT_MS }) {
  let opening = null;
  let maintenance = null;
  let projectPorts = null;
  async function application() {
    opening ??= open({ runtimeConfigPath: paths.graphRuntimeConfigPath, globalWrites });
    try { return await opening; } catch (error) { opening = null; throw error; }
  }

  async function handle(request, response, url, ids) {
    try {
      if ([FOLLOWER_GRAPH_PATH, FOLLOWER_FORMAT_PATH].includes(url.pathname)) {
        maintenance ??= import('./follower-graph-backup.js').then(module => module.followerGraphMaintenance(paths));
        const run = await maintenance;
        if (url.pathname === FOLLOWER_FORMAT_PATH) {
          const runtime = await broker()?.current();
          if (!runtime) return sendJson(response, 503, { error: 'local_runtime_unavailable' });
          await runtime.withLease({ kind: 'graph', owner: 'follower-format' }, () => run(request, response, url, ids));
        } else await run(request, response, url, ids);
        return;
      }
      if (url.pathname === '/api/personal-projects' && request.method === 'GET') {
        await mergedProjects(response, url, ids);
        return;
      }
      const runtime = await broker()?.current();
      if (!runtime) { sendJson(response, 503, { error: 'local_runtime_unavailable' }); return; }
      if (isRuntimeLeasePath(url.pathname)) {
        const system = { acquireRuntimeLease: runtime.acquire, refreshRuntimeLease: runtime.refresh,
          releaseRuntimeLease: runtime.release };
        if (!await handleRuntimeLease({ request, response, url, system })) sendJson(response, 405, { error: 'invalid_method' });
        return;
      }
      await runtime.withLease({ kind: 'graph', owner: 'follower-console' }, async () => {
        if (localGraphRequestNeedsGlobal(url, request.method, ids)) {
          const host = store.host();
          const refusal = globalCopyRefusal(host);
          if (refusal) return sendJson(response, 403, { error: refusal.code, message: refusal.message });
          guardJsonResponse(response, () => globalCopyRefusal(store.host(), host));
        }
        const app = await application();
        projectPorts ??= openProjectPorts(paths.dataDir);
        const { handleApiRequest, ...ports } = await projectPorts;
        if (!await handleApiRequest({ request, response, app, ...ports })) sendJson(response, 404, { error: 'not_found' });
      });
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const mapped = mapHttpError(error);
      sendJson(response, mapped.status, mapped.body);
    }
  }
  // The host's projects and this computer's, each marked with its owner. This computer's part
  // waits at most localListWaitMs; one that is not there by then is said in a header and the
  // host's are answered as they are (and the other way round when the host is away).
  async function mergedProjects(response, url, ids) {
    const host = store.host();
    const remote = connection.getText(`${RUNNER_PATHS.console}${url.pathname}${url.search}`, { maxBytes: 4 * 1024 * 1024 })
      .catch(() => null);
    const local = (async () => {
      const runtime = await broker()?.current();
      if (!runtime) return null;
      return runtime.withLease({ kind: 'graph', owner: 'follower-console' }, async () =>
        (await application()).listPersonalProjects({ personalSpaceId: url.searchParams.get('personalSpaceId') }));
    })().catch(() => null);
    const waited = Promise.race([local, delay(localListWaitMs, null, { ref: false })]);
    const [answer, own] = await Promise.all([remote, waited]);
    let listed = null;
    try { listed = answer?.status === 200 && !answer.tooLarge ? JSON.parse(answer.text) : null; } catch { listed = null; }
    if (!Array.isArray(listed)) response.setHeader('x-fuli-host-projects', 'unavailable');
    if (!Array.isArray(own)) response.setHeader('x-fuli-local-projects', 'unavailable');
    sendJson(response, 200, [...(Array.isArray(listed) ? listed : []).map(project => ({ ...project, owner: 'host', ownerName: host?.name })),
      ...(Array.isArray(own) ? own : []).filter(project => ids.includes(project.project_id)).map(project =>
        ({ ...project, owner: 'this_computer', ownerName: 'This computer' }))]);
  }

  return { application, handle, async close() { if (opening) await (await opening).close(); } };
}

async function openProjectPorts(dataDir) {
  const [{ handleApiRequest }, { projectHierarchyConsole }, { taskBlockerConsole }, { taskCloseConsole }] = await Promise.all([
    import('../http/api-router.js'), import('../project-hierarchy/console-port.js'),
    import('../task-blockers/console-port.js'), import('../task-closing/console-port.js')
  ]);
  return { handleApiRequest, projectHierarchy: projectHierarchyConsole(dataDir), taskBlockers: taskBlockerConsole(dataDir),
    taskClosing: taskCloseConsole(dataDir) };
}
