import { createRuntimeLeaseClient } from '../adaptive-runtime/lease-client.js';
import { shellSessionFromEnv } from '../agents/native-session-env.js';
import { openFederatedGraphApplication } from '../graphiti/federated-application.js';
import { resolveGraphRuntimeOptions } from '../graphiti/runtime-config.js';
import { requestSessionFuliDefault, SESSION_FULI_ACTIONS, switchSessionFuli } from '../graphiti/session-fuli-switch.js';
import { writeLine } from './terminal-io.js';

// fuli session start|stop|restart|status: the person's FULI switch for the
// client session this command runs in (rec#5 C3b), the same as typing
// `fuli stop` in the client. The session comes from the environment the client
// gives the processes it starts (Claude Code's `!` and Bash, Codex's `!` and
// shell), never from an argument, so one window's command cannot change
// another. fuli session default on|off|status sets whether new sessions start
// with FULI on; sessions already open keep theirs.

const USAGE = 'Usage: fuli session start|stop|restart|status [--client claude_code|codex] [--json] [--runtime-config FILE]'
  + ' | fuli session default on|off|status [--json] [--runtime-config FILE]';
// Clients that tell the processes they start which session they run in.
const ENV_CLIENTS = Object.freeze(['claude_code', 'codex']);
// A shell whose session cannot be shown to be the one the client's hooks name changes nothing.
const REFUSED = Object.freeze({
  codex_sub_agent_thread: 'This shell runs in a Codex sub-Agent thread, not in the conversation the person types in, so nothing changed. Type `fuli stop` (or start, restart, status) in the conversation itself.',
  codex_session_unproven: 'Codex named only one of the session and thread of this shell, so FULI cannot show which conversation it is; nothing changed. Type `fuli stop` (or start, restart, status) in the conversation itself.'
});
const NO_SESSION = 'No client session here: run this from inside Claude Code or Codex (for example `!fuli session stop`), or type `fuli stop` in the client itself (`/fuli stop` where FULI installed the command).';

export async function runSessionCommand(args, {
  env = process.env, cwd = process.cwd(), write = writeLine,
  openApplication = openFederatedGraphApplication, createLeases = createRuntimeLeaseClient
} = {}) {
  const { action, value, client, json, runtimeArgs } = parseSessionArguments(args);
  const target = action === 'default' ? null : hostSession(client, env);
  if (action !== 'default' && !target?.sessionId) {
    write(REFUSED[target?.refused] ?? NO_SESSION);
    return { exitCode: 1 };
  }
  const { runtimeConfigPath } = resolveGraphRuntimeOptions(runtimeArgs, env);
  const app = openApplication({ runtimeConfigPath });
  const leases = createLeases({ runtimeConfigPath });
  try {
    const result = await leases.withGraphLease('cli-session', () => action === 'default'
      ? requestSessionFuliDefault(app, { newSessions: value })
      : switchSessionFuli(app, { sessionId: target.sessionId, sourceApplication: target.sourceApplication, action,
        projectPath: cwd }));
    write(json ? JSON.stringify(result, null, 2) : result.message);
    return { exitCode: ['unsaved', 'unavailable', 'parent_stopped'].includes(result.status) ? 1 : 0 };
  } finally {
    await Promise.allSettled([leases.close(), app.close()]);
  }
}

// The first client that names a session here; a refusal counts as naming one.
function hostSession(client, env) {
  for (const sourceApplication of client ? [client] : ENV_CLIENTS) {
    const session = shellSessionFromEnv(sourceApplication, env);
    if (session) return { ...session, sourceApplication };
  }
  return null;
}

export function parseSessionArguments(args) {
  const [action, ...rest] = args;
  const value = action === 'default' ? rest.shift() : null;
  if (action === 'default' ? !['on', 'off', 'status'].includes(value) : !SESSION_FULI_ACTIONS.includes(action)) {
    throw new TypeError(USAGE);
  }
  let client = null, json = false;
  const runtimeArgs = [];
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--json' && !json) { json = true; continue; }
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) throw new TypeError(USAGE);
    if (flag === '--client' && action !== 'default' && !client && ENV_CLIENTS.includes(next)) client = next;
    else if (flag === '--runtime-config' && !runtimeArgs.length) runtimeArgs.push(flag, next);
    else throw new TypeError(USAGE);
    index += 1;
  }
  return { action, value, client, json, runtimeArgs };
}
