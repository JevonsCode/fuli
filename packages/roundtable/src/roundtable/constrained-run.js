import { homedir } from 'node:os';

import { claudeCodeConstrainedRun } from '../agents/claude-code/constrained-run.js';
import { parseFinalAnswer, resolveClientCommand, runProcess } from './wake.js';
import { wakeFailure } from './wake-failure.js';

// A plain constrained client run for text from another computer (a visit
// request's planning pass and its edit): not a session of any Agent, no grant,
// no MCP server, no person's settings. Unlike the wake port it restores no
// Agent and proves no identity; the prompt carries what the run needs as data.
//
// Clients that can be run this way, in order. Codex is not among them yet:
// before enabling it, verify that its `-c mcp_servers=…` override replaces the
// person's whole table rather than merging with it, and that its platform
// sandbox confines the shell its workspace-write mode keeps (it is not verified
// on native Windows).
const CONSTRAINED_RUN_ADAPTERS = Object.freeze({ [claudeCodeConstrainedRun.id]: claudeCodeConstrainedRun });
export const CONSTRAINED_RUN_CLIENTS = Object.freeze(Object.keys(CONSTRAINED_RUN_ADAPTERS));

// step: 'plan' (read only) or 'edit' (read and edit), each confined to cwd.
// Answers { body } or throws a wake failure (restricted_mode_unsupported when
// the client is too old to run restricted; it is never run without it).
export async function runConstrained({ client, step, cwd, prompt, timeoutMs, signal, env = process.env, home = homedir(),
  run = runProcess, readText }) {
  const adapter = Object.hasOwn(CONSTRAINED_RUN_ADAPTERS, client) ? CONSTRAINED_RUN_ADAPTERS[client] : null;
  if (!adapter) throw wakeFailure('client_unavailable', 'client_not_found', `${client} is not run for visit requests`);
  const command = resolveClientCommand(client, { env });
  if (!command) throw wakeFailure('client_unavailable', 'client_not_found', `${client} is not installed on this machine`);
  const childEnv = { ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('FULI_ROUNDTABLE_'))),
    ...adapter.environment({ env, home, ...(readText ? { readText } : {}) }) };
  // The client's own start event is the proof that the restriction holds: any
  // tool outside the step's set, or any MCP server, stops the run at once.
  let proven = false;
  const unrestricted = (output = null) => wakeFailure('wake_failed', 'restricted_mode_unsupported',
    `${client} did not start restricted; update it`, output ? { exitCode: output.code, signal: output.signal, output: { stderr: output.stderr } } : {});
  const onEvent = (event) => {
    const started = adapter.startedWith(event);
    if (!started) return;
    if (!adapter.restrictedAs(step, started)) throw unrestricted();
    proven = true;
  };
  const result = await run(command, adapter.args(step), { cwd, env: childEnv, input: prompt, timeoutMs, signal, onEvent });
  if (result.code !== 0 && adapter.restrictedUnsupported(result.stderr ?? '')) throw unrestricted(result);
  if (!proven) throw unrestricted(result);
  const { body } = parseFinalAnswer(client, result);
  return { body };
}
