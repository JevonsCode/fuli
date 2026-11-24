import { mapHttpError } from '../http/error-mapping.js';
import { sendJson } from '../http/response.js';
import { handleRuntimeLease, isRuntimeLeasePath } from '../http/runtime-lease-api.js';
import { FOLLOWER_GRAPH_PATH, FOLLOWER_FORMAT_PATH } from './follower-maintenance-paths.js';
import { RUNNER_PATHS } from './protocol.js';

async function openLocalApplication(options) {
  const { openFederatedGraphApplication } = await import('../graphiti/federated-application.js');
  return openFederatedGraphApplication(options);
}

export function createFollowerLocalApi({ paths, store, connection, broker, globalWrites, open = openLocalApplication }) {
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
          const runtime = await broker().current();
          if (!runtime) return sendJson(response, 503, { error: 'local_runtime_unavailable' });
          await runtime.withLease({ kind: 'graph', owner: 'follower-format' }, () => run(request, response, url, ids));
        } else await run(request, response, url, ids);
        return;
      }
      const runtime = await broker().current();
      if (!runtime) { sendJson(response, 503, { error: 'local_runtime_unavailable' }); return; }
      if (isRuntimeLeasePath(url.pathname)) {
        const system = { acquireRuntimeLease: runtime.acquire, refreshRuntimeLease: runtime.refresh,
          releaseRuntimeLease: runtime.release };
        if (!await handleRuntimeLease({ request, response, url, system })) sendJson(response, 405, { error: 'invalid_method' });
        return;
      }
      await runtime.withLease({ kind: 'graph', owner: 'follower-console' }, async () => {
        const app = await application();
        if (url.pathname === '/api/personal-projects' && request.method === 'GET') {
          const local = await app.listPersonalProjects({ personalSpaceId: url.searchParams.get('personalSpaceId') });
          const host = store.host();
          const remote = await connection.getText(`${RUNNER_PATHS.console}${url.pathname}${url.search}`,
            { maxBytes: 4 * 1024 * 1024 });
          const listed = remote.status === 200 && !remote.tooLarge ? JSON.parse(remote.text) : null;
          if (!Array.isArray(listed)) response.setHeader('x-fuli-host-projects', 'unavailable');
          sendJson(response, 200, [...(Array.isArray(listed) ? listed : []).map(project => ({ ...project, owner: 'host', ownerName: host?.name })),
            ...local.filter(project => ids.includes(project.project_id)).map(project =>
              ({ ...project, owner: 'this_computer', ownerName: 'This computer' }))]);
          return;
        }
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
