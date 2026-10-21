// The capture-settings fixture of rec#5 C2 and C3 tests. Synthetic only: temporary
// directories stand in for the user's repositories and a recording double stands in
// for the Provider. No FULI data directory, live Provider, port-2727 service or client
// configuration is used.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { callAgentTool } from '../../src/agent-tools.js';
import { runClaudeLifecycleHook } from '../../src/agents/claude-code/lifecycle-hook.js';
import { runCodexLifecycleHook } from '../../src/agents/codex/lifecycle-hook.js';
import { runCursorLifecycleHook } from '../../src/agents/cursor/lifecycle-hook.js';
import { CapturePolicyStore, capturePolicyPathForRuntime } from '../../src/graphiti/capture-policy.js';
import { SessionCapturePauseStore, sessionCapturePausePathForRuntime } from '../../src/graphiti/capture-session-pause.js';
import { FederatedGraphApplication } from '../../src/graphiti/federated-application.js';
import { TaskContextRegistry } from './in-memory-task-context-registry.js';

const CONFIG = { version: 1, workspaces: [], personal: { providerUrl: 'http://127.0.0.1:8787',
  accessToken: 'synthetic-token', principalId: 'synthetic-person', spaceId: 'synthetic-space' } };
// Words from a turn the user chose not to record. No receipt, store or message may keep them.
export const PRIVATE = 'synthetic-private-words';
const REGISTERED = ['thesis', 'family-ledger', 'job-hunt', 'novel'];

export async function fixture(t, { registered = REGISTERED } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fuli-capture-projects-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const dirs = {};
  // side-repo is a repository the user never registered.
  for (const id of [...REGISTERED, 'side-repo']) {
    dirs[id] = join(root, 'repos', id);
    await mkdir(join(dirs[id], '.git'), { recursive: true });
  }
  // A second working tree of thesis in an unrelated folder, as `git worktree add` makes it.
  const worktreeGit = join(dirs.thesis, '.git', 'worktrees', 'chapter-3');
  dirs.thesisWorktree = join(root, 'elsewhere', 'chapter-3');
  await mkdir(worktreeGit, { recursive: true });
  await mkdir(dirs.thesisWorktree, { recursive: true });
  await writeFile(join(dirs.thesisWorktree, '.git'), `gitdir: ${worktreeGit}\n`);
  dirs.downloads = join(root, 'Downloads');
  await mkdir(dirs.downloads);

  const runtimeConfigPath = join(root, 'runtime', 'graph-runtime.json');
  await mkdir(join(root, 'runtime'));
  const clock = { now: '2026-10-20T08:00:00.000Z' };
  const store = new CapturePolicyStore(capturePolicyPathForRuntime(runtimeConfigPath), { now: () => clock.now });
  const sessionPauses = new SessionCapturePauseStore(sessionCapturePausePathForRuntime(runtimeConfigPath),
    { now: () => clock.now });
  const projects = new Set(registered);
  const writes = [];
  const knowledge = [];
  const cursors = new Map();
  const app = new FederatedGraphApplication(CONFIG, { capturePolicyStore: store, sessionCapturePauseStore: sessionPauses,
    runtimeConfigPath,
    taskContextRegistry: new TaskContextRegistry(),
    fetchImpl: async url => { throw new Error(`Unexpected Provider request ${new URL(url).pathname}`); } });
  // The turn receipt's read-back (rec#20): these tests check notices, not saved items.
  app.personal.readTurnReceipt = async () => ({ entries: [], unchanged_count: 0 });
  app.upsertPersonalProject = async input => {
    writes.push({ kind: 'project', project: input.projectId });
    projects.add(input.projectId);
    return projectRecord(input.projectId);
  };
  Object.assign(app.personal, {
    listPersonalProjects: async () => [...projects].map(projectRecord),
    getPersonalProject: async (_space, id) => {
      if (!projects.has(id)) throw Object.assign(new Error('Not found'), { status: 404 });
      return projectRecord(id);
    },
    listProjectAgentAssignments: async () => [],
    resolveProjectAgentContext: async input => ({ status: 'ready', agent: lead(input.personal_project_id) }),
    getProjectAgent: async (_space, project) => lead(project),
    collaborationPreferences: async (space, project, _limit, agent) => ({ personal_space_id: space,
      personal_project_id: project, project_agent_id: agent, effective_preferences: [], global_preferences: [], conflicts: [] }),
    listPreferenceConflicts: async () => [],
    getProjectAgentCoordinationPolicy: async () => ({}),
    listProjectAgents: async () => [],
    listProjectAgentTasks: async () => [],
    recordAgentViews: async () => ({ status: 'recorded' }),
    // Each conversation keeps the transcript cursor its last write moved to.
    conversation: async (operation, input) => {
      const key = [input.personal_project_id, input.agent_id, input.session_id].join(':');
      if (operation === 'query') {
        return input.mode === 'policy' ? { enabled: true } : { cursor: cursors.get(key) ?? 0, initialized: true };
      }
      writes.push({ kind: 'conversation', operation, project: input.personal_project_id ?? null,
        content: (input.events ?? []).map(event => event.content).join(' | ') });
      if (Number.isSafeInteger(input.cursor)) cursors.set(key, input.cursor);
      return { status: 'saved', conversation_id: `conversation-${writes.length}` };
    },
    preflightCommits: async commits => ({ status: 'validated', count: commits.length }),
    commit: async commit => {
      writes.push({ kind: 'knowledge', project: commit.personal_project_id });
      knowledge.push(commit);
      return { status: 'committed', episode_id: `episode-${knowledge.length}`,
        entity_ids: commit.episode.entities.map(entity => `entity-${knowledge.length}-${entity.key}`), relationship_ids: [] };
    }
  });
  app.searchKnowledge = async () => ({ facts: knowledge.map(commit => ({ episode: commit.episode.name,
    personal_project_id: commit.personal_project_id })), entities: [] });
  return { root, dirs, app, store, sessionPauses, clock, projects, writes, knowledge, runtimeConfigPath,
    captureWrites: () => writes.filter(write => write.kind !== 'project') };
}

function projectRecord(id) {
  return { project_id: id, scope_type: 'registered', profile: { name: id } };
}

function lead(project) {
  return { agent_id: `lead-${project ?? 'global'}`, personal_space_id: 'synthetic-space', personal_project_id: project,
    memory_scope: 'reviewed_agent', profile: { name: `Lead ${project ?? 'global'}`, status: 'active',
      allowed_clients: ['codex', 'claude_code', 'cursor'], work_kinds: ['project_context'], capabilities: [] } };
}

// Hook capture windows get far more than the production 750 ms: these tests are
// about which turns are recorded, not about a loaded runner's I/O timing.
const FUNCTIONAL_CAPTURE_MS = 30_000;
const leases = () => ({ withGraphLease: async (_owner, operation) => operation(), close: async () => {} });

// A Codex prompt through its real lifecycle hook and the real begin_task_context tool.
export async function codexEntry(f, cwd, { session = 'synthetic-codex-session', prompt = `Plan ${PRIVATE}.`,
  transcriptPath = undefined } = {}) {
  let context;
  const output = await runCodexLifecycleHook(['--event', 'UserPromptSubmit'], {
    readInput: async () => ({ session_id: session, cwd, prompt, ...(transcriptPath ? { transcript_path: transcriptPath } : {}) }),
    write: () => {},
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
    createLeases: leases, captureTimeoutMs: FUNCTIONAL_CAPTURE_MS,
    callTool: async (app, name, input, request) => {
      const result = await callAgentTool(app, name, input, request);
      if (name === 'begin_task_context') context = result;
      return result;
    }
  });
  return { output, context };
}

export async function claudeEntry(f, cwd, { session = 'synthetic-claude-session', prompt = `Plan ${PRIVATE}.` } = {}) {
  let context;
  const output = await runClaudeLifecycleHook(['--event', 'UserPromptSubmit'], {
    readInput: async () => ({ session_id: session, cwd, prompt }),
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
    createLeases: leases, captureTimeoutMs: FUNCTIONAL_CAPTURE_MS,
    callTool: async (app, name, input, request) => {
      const result = await callAgentTool(app, name, input, request);
      if (name === 'begin_task_context') context = result;
      return result;
    }
  });
  return { output, context };
}

// Cursor's hook starts the task; its Agent then reads the receipt from
// get_collaboration_preferences, as the sessionStart guidance tells it to.
export async function cursorEntry(f, cwd, { session = 'synthetic-cursor-session', prompt = `Plan ${PRIVATE}.` } = {}) {
  const output = await runCursorLifecycleHook(['--event', 'beforeSubmitPrompt'], {
    readInput: async () => ({ conversation_id: session, workspace_roots: [cwd], prompt }), write: () => {},
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
    createLeases: leases
  });
  const context = await callAgentTool(f.app, 'get_collaboration_preferences', { projectPath: cwd, taskPrompt: prompt,
    sessionId: session, sourceApplication: 'cursor', sourceSessionId: session });
  return { output, context };
}

// The finishing checkpoint of a task: a global preference, and a project fact
// when the task has a project.
export function finishTask(f, context, sourceApplication = 'codex') {
  return callAgentTool(f.app, 'checkpoint_task_knowledge', { taskContextToken: context.taskContextToken,
    sourceApplication, disposition: 'capture_candidates', reason: `Finished ${PRIVATE}.`,
    workLog: { status: 'completed', summary: `Did ${PRIVATE}.` },
    remember: [{ kind: 'preference', text: `Prefers ${PRIVATE}.`, quote: `I prefer ${PRIVATE}.` },
      ...(context.context.personal_project_id ? [{ kind: 'project_fact', text: `The ${PRIVATE} draft is due Friday.` }] : [])] });
}

export const receiptOf = context => context.agent_receipt.markdown;

// A long-term change an Agent makes after the person confirmed its preview (rec#5 C4-2).
export async function confirmedCaptureChange(f, settings, sourceApplication = undefined) {
  const client = sourceApplication ? { sourceApplication } : {};
  const preview = await callAgentTool(f.app, 'update_capture_policy', { ...settings, ...client });
  if (preview.status !== 'confirmation_required') throw new Error(`Expected a preview, got ${preview.status}`);
  return callAgentTool(f.app, 'update_capture_policy', { ...settings, ...client, previewToken: preview.previewToken });
}

export const transcriptRow = text => `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text }] } })}
`;

// A Codex Stop hook through its real lifecycle: the transcript sync and the
// per-session record of the settings it last ran under.
export function codexStop(f, input) {
  return runCodexLifecycleHook(['--event', 'Stop'], { readInput: async () => input, write: () => {},
    resolveRuntimeOptions: () => ({ runtimeConfigPath: f.runtimeConfigPath }), openApplication: () => f.app,
    createLeases: leases, captureTimeoutMs: FUNCTIONAL_CAPTURE_MS });
}
