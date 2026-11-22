import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Whether a data directory belongs to a runner (docs/runner.md): it paired
// with a host and has no graph runtime of its own. The MCP entry then serves
// through the host and lifecycle hooks load nothing; at a prompt they tell the
// model to enter the task through MCP instead (RUNNER_HOOK_CONTEXT). Only Node
// built-ins load here: the thin hook entry decides with it before loading
// anything else.
const RUNNER_STORE = join('runner', 'runner.sqlite');

// What every client's prompt hook says on a runner, where the client can put
// model-visible text at a prompt.
export const RUNNER_HOOK_CONTEXT = 'This computer is a FULI runner, so this hook loaded nothing. Before answering, call FULI\'s '
  + 'get_collaboration_preferences with projectPath=current directory and taskPrompt=current request; it reaches the FULI host.';

// The same for a client whose MCP server cannot name its session (Cursor): its
// session start hook is the only place the model learns the session, and a task
// entered without it has no task token, so no call that needs one (resuming a
// conversation, a checkpoint) can follow. sessionId: the client's own session.
export function runnerSessionStartContext(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256) return RUNNER_HOOK_CONTEXT;
  return 'This computer is a FULI runner, so this hook loaded nothing. For every user task, before answering, call FULI\'s '
    + `get_collaboration_preferences with sessionId=${JSON.stringify(sessionId)}, projectPath=current directory and `
    + 'taskPrompt=current request; it reaches the FULI host and returns a taskContextToken. Pass the latest '
    + 'taskContextToken to every FULI call, resume_agent_conversation and checkpoint_task_knowledge included.';
}

// Start, setup and FULI.app ask it too: on a runner they never set up a graph runtime.
export function isRunnerDataDirectory(dataDir) {
  return existsSync(join(dataDir, RUNNER_STORE)) && !existsSync(join(dataDir, 'graph-runtime.json'));
}

// The same, for a hook or MCP command line naming --runtime-config.
export function runnerRuntimeConfig(argv) {
  const index = argv.indexOf('--runtime-config');
  const configPath = index >= 0 ? argv[index + 1] : null;
  return typeof configPath === 'string' && configPath ? isRunnerDataDirectory(dirname(resolve(configPath))) : false;
}
