// One installed Claude Code hook call in its own process, against a synthetic
// Provider double, so tests can interleave hook processes of one session
// through what FULI persists between them. Synthetic data only.
//   node test-support/claude-hook-process.mjs '<json>'
//   json: { event, runtimeConfigPath, transcript, sessionId, prompt?, waitInEntry?: { started, release } }
// With waitInEntry, task entry writes `started` and then waits for `release` to exist.
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { runClaudeLifecycleHook } from '../src/agents/claude-code/lifecycle-hook.js';

const request = JSON.parse(process.argv[2]);
const task = { token: 'fuli-task-synthetic-a', project_agent_id: 'engineer', personal_project_id: 'synthetic-project',
  session_id: request.sessionId, source_application: 'claude_code', personal_space_id: 'synthetic-space', entry_via: 'hook' };
const app = { config: { personal: { spaceId: 'synthetic-space' } }, getCapturePolicy: () => ({ enabled: true }),
  getCapturePolicyVersion: () => 'absent',
  taskContextRegistry: { current: async () => ({ token: task.token, sessionId: request.sessionId,
    sourceApplication: 'claude_code', checkpoint: null }) },
  personal: {
    currentTaskContext: async () => task,
    conversation: async (_operation, query) => query.mode === 'policy' ? { enabled: true }
      : query.mode === 'session' ? { initialized: true, cursor: 0 } : { status: 'saved' }
  } };
const output = await runClaudeLifecycleHook(['--event', request.event], {
  readInput: async () => ({ session_id: request.sessionId, cwd: '/synthetic/project', transcript_path: request.transcript,
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }) }),
  resolveRuntimeOptions: () => ({ runtimeConfigPath: request.runtimeConfigPath }), openApplication: () => app,
  createLeases: () => ({ withGraphLease: async (_owner, run) => run() }), captureTimeoutMs: 30_000,
  callTool: async (_app, name, parameters) => {
    if (name === 'begin_task_context') {
      if (request.waitInEntry) {
        writeFileSync(request.waitInEntry.started, 'entering');
        for (let waited = 0; !existsSync(request.waitInEntry.release); waited += 50) {
          if (waited > 30_000) throw new Error('synthetic barrier timed out');
          await delay(50);
        }
      }
      return { taskContextToken: 'fuli-task-synthetic-b', effective_preferences: [] };
    }
    if (name === 'read_task_preferences') return { taskContextToken: parameters.taskContextToken, effective_preferences: [] };
    return { status: 'saved' };
  } });
process.stdout.write(JSON.stringify(output));
