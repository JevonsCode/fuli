// One installed Claude Code hook call in its own process, against a synthetic
// Provider double whose state (current task, checkpoints, transcript cursor
// and imported events) is kept in a JSON file shared by the processes of one
// test. Tests interleave hook processes of one session through that file and
// what FULI itself persists. Synthetic data only; not the real Provider.
//   node test-support/claude-hook-process.mjs '<json>'
//   json: { event, runtimeConfigPath, transcript, sessionId, providerState, prompt?, waitInEntry?: { started, release } }
// With waitInEntry, task entry writes `started` and then waits for `release` to exist.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { runClaudeLifecycleHook } from '../src/agents/claude-code/lifecycle-hook.js';

const request = JSON.parse(process.argv[2]);
const task = token => ({ token, project_agent_id: 'engineer', personal_project_id: 'synthetic-project',
  session_id: request.sessionId, source_application: 'claude_code', personal_space_id: 'synthetic-space', entry_via: 'hook' });
const initial = { current: 'fuli-task-synthetic-a', checkpointed: [], cursor: 0, events: [], calls: [] };
// Each operation reads and writes the shared state, so a process that waits never writes back an old copy.
const provider = operation => {
  const state = existsSync(request.providerState) ? JSON.parse(readFileSync(request.providerState, 'utf8')) : initial;
  const result = operation(state);
  writeFileSync(request.providerState, JSON.stringify(state));
  return result;
};
const app = { config: { personal: { spaceId: 'synthetic-space' } }, getCapturePolicy: () => ({ enabled: true }),
  getCapturePolicyVersion: () => 'absent',
  taskContextRegistry: { current: async () => provider(state => ({ token: state.current, sessionId: request.sessionId,
    sourceApplication: 'claude_code', checkpoint: state.checkpointed.includes(state.current) ? { phase: 'complete' } : null })) },
  personal: {
    currentTaskContext: async () => provider(state => task(state.current)),
    conversation: async (operation, query) => provider(state => {
      if (query.mode === 'policy') return { enabled: true };
      if (query.mode === 'session') return { initialized: true, cursor: state.cursor };
      if (operation === 'append') {
        if (query.expected_cursor !== state.cursor) throw new Error('synthetic cursor conflict');
        state.events.push(...query.events.map(event => ({ token: query.task_context_token, content: event.content })));
        state.cursor = query.cursor;
      } else if (operation === 'boundary' && Number.isSafeInteger(query.cursor)) state.cursor = query.cursor;
      return { status: 'saved', cursor: state.cursor };
    })
  } };
const output = await runClaudeLifecycleHook(['--event', request.event], {
  readInput: async () => ({ session_id: request.sessionId, cwd: '/synthetic/project', transcript_path: request.transcript,
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }) }),
  resolveRuntimeOptions: () => ({ runtimeConfigPath: request.runtimeConfigPath }), openApplication: () => app,
  createLeases: () => ({ withGraphLease: async (_owner, run) => run() }), captureTimeoutMs: 30_000,
  callTool: async (_app, name, parameters) => {
    provider(state => { state.calls.push([name, parameters.taskContextToken ?? null]); });
    if (name === 'begin_task_context') {
      if (request.waitInEntry) {
        writeFileSync(request.waitInEntry.started, 'entering');
        for (let waited = 0; !existsSync(request.waitInEntry.release); waited += 50) {
          if (waited > 30_000) throw new Error('synthetic barrier timed out');
          await delay(50);
        }
      }
      return provider(state => {
        state.current = 'fuli-task-synthetic-b';
        return { taskContextToken: state.current, effective_preferences: [] };
      });
    }
    if (name === 'read_task_preferences') return { taskContextToken: parameters.taskContextToken, effective_preferences: [] };
    if (name === 'verify_task_checkpoint') return provider(state => state.checkpointed.includes(state.current)
      ? { status: 'checkpointed' }
      : { decision: 'block', entry_via: 'hook', task_context_token: state.current, reason: 'FULI_CHECKPOINT_REQUIRED: synthetic' });
    if (name === 'checkpoint_task_knowledge') provider(state => { state.checkpointed.push(parameters.taskContextToken); });
    return { status: 'saved' };
  } });
process.stdout.write(JSON.stringify(output));
