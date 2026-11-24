// A synthetic Graph Provider double and data directory for running the real
// installed lifecycle hooks end to end: the hook's own modules, local stores
// and HTTP calls, against a Provider that answers just enough for a task
// entry (one registered project, task contexts kept in memory). Synthetic
// data only; real persistence is tested against a disposable Neo4j Provider.
// Used by test/lifecycle-hook-forwarding.test.js and
// acceptance/hook-forwarding/measure.js.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

export const SYNTHETIC_PROJECT_ID = 'synthetic-hook-project';

// The project's lead and the person's habits an assigned entry carries.
const SYNTHETIC_LEAD = { agent_id: 'synthetic-lead', personal_space_id: 'synthetic-space', personal_project_id: SYNTHETIC_PROJECT_ID,
  profile: { name: 'Synthetic lead', responsibility: 'Synthetic project lead', capabilities: ['project_context'],
    status: 'active', allowed_clients: ['claude_code', 'codex'] },
  created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' };
const SYNTHETIC_HABITS = [1, 2, 3].map(index => ({ id: `synthetic-habit-${index}`, item_kind: 'entity',
  preference_key: `synthetic.habit.${index}`, instruction: `Synthetic habit ${index}.`, preference_scope: 'global',
  confirmation_status: 'confirmed' }));

// assignedEntry: answer as a project whose lead takes the task, with three
// habits, and open a new conversation for each native session (its later
// tasks recover it), so a measurement runs the entry path people have, the
// first-reply habits line included. Without it the entry has no Agent and no
// complete preferences.
export async function startSyntheticHookProvider({ assignedEntry = false } = {}) {
  const contexts = new Map();
  const current = new Map();
  const conversations = new Map();
  let requests = 0;
  const assigned = (path, query, body) => {
    if (path === '/v1/project-agent-context/resolve') {
      return [200, { status: 'ready', reason: 'project_lead', agent: SYNTHETIC_LEAD, match_basis: ['project_lead'] }];
    }
    if (path === '/v1/project-agents') return [200, [SYNTHETIC_LEAD]];
    if (path === '/v1/collaboration-preferences') {
      return [200, { personal_space_id: query.personal_space_id, personal_project_id: query.personal_project_id ?? null,
        project_agent_id: query.project_agent_id ?? null, effective_preferences: SYNTHETIC_HABITS,
        global_preferences: SYNTHETIC_HABITS, project_preferences: [], agent_preferences: [], conflicts: [], truncated: false,
        source_windows: { candidates_truncated: false, project_ancestors_truncated: false, queued_conflicts_truncated: false } }];
    }
    if (path === '/v1/agent-conversations/begin') {
      const session = `${body.agent_id}:${body.source_application}:${body.session_id}`;
      const recovered = conversations.get(session) ?? null;
      if (!recovered) conversations.set(session, `synthetic-conversation-${conversations.size + 1}`);
      return [200, { status: 'saved', conversation_id: conversations.get(session), revision: 0, recovered_from: recovered,
        previous: null, recent: null }];
    }
    return null;
  };
  const answer = (method, path, query, body) => {
    const entry = assignedEntry ? assigned(path, query, body) : null;
    if (entry) return entry;
    if (path === '/v1/task-context-sessions/current') {
      const record = current.get(query.session_id);
      return record ? [200, record] : [404, { detail: 'not found' }];
    }
    if (path === '/v1/personal-projects') {
      return [200, [{ project_id: SYNTHETIC_PROJECT_ID, profile: { name: 'Synthetic hook project', lifecycle: 'active' } }]];
    }
    if (path === '/v1/task-contexts' && method === 'PUT') {
      const record = { ...body, checkpoint: null };
      contexts.set(body.token, record);
      current.set(body.session_id, record);
      return [200, record];
    }
    if (path.startsWith('/v1/task-contexts/')) {
      const record = contexts.get(decodeURIComponent(path.split('/')[3]));
      return record ? [200, record] : [404, { detail: 'not found' }];
    }
    if (path === '/v1/collaboration-preferences') return [200, []];
    return [200, {}];
  };
  const server = createServer(async (request, response) => {
    requests += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const url = new URL(request.url, 'http://127.0.0.1');
    let status = 400;
    let body = { detail: 'synthetic invalid body' };
    try {
      [status, body] = answer(request.method, url.pathname, Object.fromEntries(url.searchParams), text ? JSON.parse(text) : null);
    } catch { /* answered 400 */ }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests: () => requests,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}

// A data directory whose graph-runtime.json names the Provider double, with a
// folder named as the registered project and one that matches no project.
export function syntheticHookDataDirectory(parent, providerUrl) {
  const root = mkdtempSync(join(parent, 'fuli-hook-data-'));
  const dataDir = join(root, 'data');
  const projectPath = join(root, SYNTHETIC_PROJECT_ID);
  const otherPath = join(root, 'synthetic-unregistered-folder');
  for (const directory of [dataDir, projectPath, otherPath]) mkdirSync(directory, { recursive: true });
  const runtimeConfigPath = join(dataDir, 'graph-runtime.json');
  writeFileSync(runtimeConfigPath, JSON.stringify({ version: 1, personal: { providerUrl,
    accessToken: 'synthetic-hook-access-token-0123456789', principalId: 'synthetic-principal',
    spaceId: 'synthetic-space' }, workspaces: [] }));
  return { root, dataDir, runtimeConfigPath, projectPath, otherPath,
    remove: () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }) };
}

// The record the forwarder reads to find the console (setup/graph-runtime.js
// writes the real one when it starts the console).
export function recordConsole(dataDir, { url, pid = process.pid }) {
  writeFileSync(join(dataDir, 'graph-runtime-state.json'), JSON.stringify({ version: 4, pid, url }));
}

export function forgetConsole(dataDir) {
  rmSync(join(dataDir, 'graph-runtime-state.json'), { force: true });
}
