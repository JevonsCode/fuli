import { join } from 'node:path';

import { loadDeviceIdentity } from '../../packages/roundtable/src/peer/device-identity.js';
import { createHostConnection } from '../runner/host-connection.js';
import { joinHost } from '../runner/join.js';
import { deliverOutbox } from '../runner/outbox-delivery.js';
import { RUNNER_FILE, RunnerStore } from '../runner/runner-store.js';
import { parseSetupOptions } from '../setup/options.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { applyLocalSetup, planLocalSetup } from '../setup/setup.js';
import { localConsoleUrl } from './console-url.js';
import { writeLine } from './terminal-io.js';

// `fuli runner` (docs/runner.md). On the host: invite, list, revoke, through
// the local console. On a runner: join (pair, then set up its clients as
// `fuli setup` does, with no graph runtime), status and sync.
const USAGE = `fuli runner <action>  (runners: other computers whose clients use this FULI)
  On the host:
    invite [--name NAME]          print a one-use invitation for a runner (10 minutes)
    list                          paired runners and where the host listens
    revoke FINGERPRINT            end a runner's access (8 or more characters of its fingerprint)
  On a runner:
    join INVITATION [--name NAME] pair with the host and set up this computer's clients
    status                        the host, whether it answers, and the outbox
    sync                          deliver the outbox now
  Every action takes --data-dir DIR.`;

export async function runRunnerCommand(args, { env = process.env, fetchImpl = fetch, write = writeLine,
  join: joinRunner = joinHost, setupClients = setUpRunnerClients } = {}) {
  const [action, ...rest] = args;
  const dataDir = option(rest, '--data-dir');
  const paths = () => resolveSetupPaths({ dataDir, env });
  if (!action || action === '--help' || action === '-h') return void write(USAGE);
  if (action === 'invite' || action === 'list' || action === 'revoke') {
    return consoleAction(action, rest, { baseUrl: localConsoleUrl({ dataDir, env }), fetchImpl, write });
  }
  if (action === 'join') {
    const invitation = rest.find((value, index) => !value.startsWith('--') && !['--name', '--data-dir'].includes(rest[index - 1]));
    if (!invitation) throw new TypeError(`Missing invitation\n${USAGE}`);
    const joined = await joinRunner({ dataDir: paths().dataDir, invitation, name: option(rest, '--name') ?? null });
    write(`Paired with ${joined.host.name} (${joined.host.address}:${joined.host.port}).`);
    write(`This runner's fingerprint: ${joined.runner.fingerprint.slice(0, 16)}…`);
    const clients = await setupClients({ dataDir: paths().dataDir, env, write });
    write(clients.length ? 'Clients set up:' : 'No Agent client was found here. After installing one, run `fuli runner join` with a new invitation.');
    for (const client of clients) write(`  ${client.label ?? client.id}: ${client.status}`);
    write('Restart those clients. Their FULI tools now use the host; nothing of FULI\'s knowledge is kept here.');
    return { exitCode: clients.every((client) => client.status === 'connected') ? 0 : 1 };
  }
  if (action === 'status' || action === 'sync') {
    const store = new RunnerStore(join(paths().dataDir, RUNNER_FILE));
    try {
      const host = store.host();
      if (!host) return void write('This computer is not a runner. Pair it with `fuli runner join INVITATION`.');
      const identity = await loadDeviceIdentity(join(paths().dataDir, 'peer'));
      const connection = createHostConnection({ store, identity });
      try {
        const reached = await connection.connect();
        write(`Host: ${host.name} — ${reached ? `answering at ${reached.address}:${host.port}` : 'not reachable now'}`);
        const outbox = action === 'sync' && reached ? await deliverOutbox({ store, connection }) : store.outbox();
        if (action === 'sync' && reached) write(`Delivered ${outbox.delivered}, refused ${outbox.failed}.`);
        write(`Outbox: ${outbox.queued} waiting${outbox.failed.length ? `, ${outbox.failed.length} refused by the host` : ''}.`);
        for (const entry of outbox.failed) write(`  ${entry.queuedAt} ${entry.tool}: ${entry.reason}`);
        return { exitCode: reached ? 0 : 1 };
      } finally {
        connection.close();
      }
    } finally {
      store.close();
    }
  }
  throw new TypeError(`Unknown runner action: ${action}\n${USAGE}`);
}

// The clients `fuli setup` would set up here, written with the same entries;
// the MCP entry then serves through the host (src/cli/mcp-command.js).
async function setUpRunnerClients({ dataDir, env, write, plan = planLocalSetup, apply = applyLocalSetup }) {
  const options = { ...parseSetupOptions(['--yes']), dataDir };
  const planned = await plan(options, { env });
  const result = await apply(planned, options, { env, onProgress: write,
    ensureRuntime: async () => ({ status: 'runner' }) });
  return result.agents;
}

async function consoleAction(action, args, { baseUrl, fetchImpl, write }) {
  const request = (method, path, body) => fetchImpl(`${baseUrl}${path}`, { method,
    headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    .catch(() => { throw new Error('The local FULI console is not running; start it with `fuli start`.'); });
  const read = async (answer) => {
    const body = await answer.json().catch(() => ({}));
    if (!answer.ok) throw new Error(`Runner ${action} failed: ${body.code ?? body.error ?? answer.status}`);
    return body;
  };
  if (action === 'invite') {
    const body = await read(await request('POST', '/api/runners/invitations', { name: option(args, '--name') }));
    write('On the runner, run this within 10 minutes (it works once):');
    write('');
    write(`  fuli runner join ${body.invitation}`);
    write('');
    write(`The host listens at ${body.addresses.join(', ')} on port ${body.port}.`);
    write('A runner gets full read and write access to this FULI. Revoke it with `fuli runner revoke`.');
    return { exitCode: 0 };
  }
  if (action === 'list') {
    const body = await read(await request('GET', '/api/runners'));
    write(body.listening ? `Listening at ${body.addresses.join(', ')} on port ${body.port}.`
      : `Not listening${body.problem ? ` (${body.problem})` : ''}.`);
    if (!body.runners.length) write('No runner paired.');
    for (const runner of body.runners) {
      write(`  ${runner.fingerprint.slice(0, 16)}  ${runner.name}  ${runner.revokedAt ? `revoked ${runner.revokedAt}`
        : `last seen ${runner.lastSeenAt ?? 'never'}${runner.lastAddress ? ` from ${runner.lastAddress}` : ''}`}`);
    }
    return { exitCode: 0 };
  }
  const fingerprint = args.find((value) => !value.startsWith('--') && args[args.indexOf(value) - 1] !== '--data-dir');
  if (!fingerprint) throw new TypeError(`Missing fingerprint\n${USAGE}`);
  await read(await request('DELETE', `/api/runners/${encodeURIComponent(fingerprint.toLowerCase())}`));
  write('Revoked. That runner can no longer reach this FULI.');
  return { exitCode: 0 };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}
