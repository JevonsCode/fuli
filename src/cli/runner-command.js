import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { loadDeviceIdentity } from '../../packages/roundtable/src/peer/device-identity.js';
import { createHostConnection } from '../runner/host-connection.js';
import { joinHost } from '../runner/join.js';
import { deliverOutbox } from '../runner/outbox-delivery.js';
import { ROUTING_LEDGER_FILE } from '../runner/routing-ledger.js';
import { isReachableHostAddress } from '../server/lan-access.js';
import { mcpSessionsLine } from '../runner/protocol.js';
import { RUNNER_FILE, RunnerStore } from '../runner/runner-store.js';
import { parseSetupOptions } from '../setup/options.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { applyLocalSetup, planLocalSetup } from '../setup/setup.js';
import { localConsoleUrl } from './console-url.js';
import { capabilityLines, serveFollowerConsole } from '../runner/follower-runtime.js';
import { followerStatus } from '../runner/follower-status.js';
import { writeLine } from './terminal-io.js';

// `fuli runner` (docs/runner.md). On the host: invite, list, revoke, through
// the local console. On a runner: join (pair, then set up its clients as
// `fuli setup` does, with no graph runtime), status, sync and leave.
const USAGE = `fuli runner <action>  (Beta. Runners: other computers whose clients use this FULI)
  On the host:
    invite [--name NAME]          print a one-use invitation for a runner (10 minutes)
    list                          paired runners and where the host listens
    revoke FINGERPRINT            end a runner's access (8 or more characters of its fingerprint)
  On a runner:
    join INVITATION [--name NAME] [--force]
                                  pair with the host and set up this computer's clients
                                  (--force: also when checkpoints for another host would be dropped)
                                  (NAME: what the host shows for this computer; default its own name)
    status                        the host, whether it answers, and the outbox
    sync                          deliver the outbox now
    add-address ADDRESS           where the host is now, when this computer cannot find it by
                                  itself (another subnet, as in an office); kept for next time,
                                  then the outbox is delivered as with sync
    leave [--force]               end the pairing here and delete what is kept here
                                  (--force: also when checkpoints never reached the host)
    console [--port PORT]         serve the host's console on this computer (fuli start runs it)
  Every action takes --data-dir DIR.`;
// What a runner keeps (runner-store.js), said where it pairs.
const KEPT_HERE = 'Kept here: the host\'s last answers to read-only calls (shown, marked offline, while the host is away; '
  + 'deleted after 30 days) and checkpoints waiting for the host (deleted once delivered; refused ones after 30 days). '
  + 'If the host revokes this computer, the answers go at once and the checkpoints wait, refused, until it joins the same '
  + 'host again. Nothing else of FULI\'s knowledge is stored here; `fuli runner leave` deletes it all.';
const JOIN_AGAIN = 'Join again: `fuli runner invite` on the host, then `fuli runner join INVITATION` here.';

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
    const invitation = positional(rest, ['--name']);
    if (!invitation) throw new TypeError(`Missing invitation\n${USAGE}`);
    const joined = await joinRunner({ dataDir: paths().dataDir, invitation, name: option(rest, '--name') ?? null,
      force: rest.includes('--force') });
    write(`Paired with ${joined.host.name} (${joined.host.address}:${joined.host.port}).`);
    write(`This runner's fingerprint: ${joined.runner.fingerprint.slice(0, 16)}…`);
    if (joined.outbox?.dropped) {
      write(`${joined.outbox.dropped} checkpoint(s) kept for the previous host were dropped: they belonged to its knowledge.`);
    }
    if (joined.outbox?.requeued) {
      const waiting = await deliverQueued(paths().dataDir);
      write(`${joined.outbox.requeued} checkpoint(s) held while this computer was revoked `
        + (waiting === null ? 'are queued again and go when the host answers.' : `were delivered (${waiting} still waiting).`));
    }
    const clients = await setupClients({ dataDir: paths().dataDir, env, write });
    write(clients.length ? 'Clients set up:' : 'No Agent client was found here. After installing one, run `fuli runner join` with a new invitation.');
    for (const client of clients) write(`  ${client.label ?? client.id}: ${client.status}`);
    write('Restart those clients. Their FULI tools now use the host.');
    write(KEPT_HERE);
    return { exitCode: clients.every((client) => client.status === 'connected') ? 0 : 1 };
  }
  if (action === 'console') {
    const port = Number(option(rest, '--port') ?? new URL(localConsoleUrl({ dataDir, env })).port);
    const served = await serveFollowerConsole({ dataDir: paths().dataDir, port });
    write(`Runner console: ${served.url}`);
    return new Promise(() => {});
  }
  if (action === 'leave') return leaveHost(paths().dataDir, write, { force: rest.includes('--force') });
  if (action === 'status' || action === 'sync' || action === 'add-address') {
    const named = action === 'add-address' ? positional(rest) : null;
    // An address a host serves: the paired certificate is checked there anyway, but nothing is sent anywhere else.
    if (action === 'add-address' && !isReachableHostAddress(named ?? '')) {
      throw new TypeError('add-address takes the host\'s private or VPN IPv4 address '
        + `(as 10.x, 172.16-31.x, 192.168.x, or 100.64-127.x from Tailscale and the like)\n${USAGE}`);
    }
    const store = new RunnerStore(join(paths().dataDir, RUNNER_FILE));
    try {
      const host = store.host();
      if (!host) return void write('This computer is not a runner. Pair it with `fuli runner join INVITATION`.');
      if (named) store.learnHostAddresses([named]);
      if (host.revokedAt) {
        write(`${host.name} revoked this computer or does not know it (${host.revokedAt}).`);
        write(`${store.outbox().failedCount} checkpoint(s) wait here refused; joining ${host.name} again delivers them.`);
        write(JOIN_AGAIN);
        return { exitCode: 1 };
      }
      const identity = await loadDeviceIdentity(join(paths().dataDir, 'peer'));
      const connection = createHostConnection({ store, identity });
      try {
        // The same description the console entry and `fuli status` show (follower-status.js).
        const state = await followerStatus({ store, connection, dataDir: paths().dataDir });
        if (state.host.revokedAt) {
          write(`${host.name} answered that it does not know this computer (revoked, or it lost its records); `
            + `its answers kept here are deleted and ${state.outbox.failedCount} checkpoint(s) wait refused. ${JOIN_AGAIN}`);
          return { exitCode: 1 };
        }
        const reached = state.host.reachable;
        write(`Host: ${host.name} — ${reached ? `answering at ${state.host.address}:${host.port}`
          + `${state.host.via ? ` (from ${state.host.via})` : ''}` : 'not reachable now'}`);
        write(`Last synced: ${state.host.lastSeenAt ?? 'never'}.`);
        if (!reached && !named) {
          write('In another subnet (an office network, say) this computer cannot find the host by itself: '
            + '`fuli runner add-address ADDRESS` with the host\'s address, which `fuli runner list` shows there.');
        }
        if (state.host.mcpSessions) write(mcpSessionsLine(state.host.mcpSessions));
        if (state.host.pinFailed) {
          write(`Something answered at ${host.name}'s address with another certificate than the paired one. `
            + `If the host was reinstalled, join again. ${JOIN_AGAIN}`);
        }
        const delivering = action !== 'status' && reached;
        const outbox = delivering ? await deliverOutbox({ store, connection }) : state.outbox;
        if (delivering) write(`Delivered ${outbox.delivered}, refused ${outbox.refused}.`);
        write(`Outbox: ${outbox.queued} waiting${outbox.failed.length ? `, ${outbox.failed.length} refused by the host` : ''}.`);
        for (const entry of outbox.failed) write(`  ${entry.queuedAt} ${entry.tool}: ${entry.reason}`);
        for (const line of capabilityLines(state.capabilities)) write(line);
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

// Ends this computer's pairing: the store goes (the host, the answers, the
// offline task tokens and the outbox), and so does the ledger of executor
// decisions made here, so the MCP entry no longer serves as a runner. Checkpoints that never reached the host are knowledge the person
// would lose: with any left it only says how many, unless --force. The host
// lists the runner until the person revokes it there.
async function leaveHost(dataDir, write, { force = false } = {}) {
  const file = join(dataDir, RUNNER_FILE);
  const store = new RunnerStore(file);
  let host;
  try {
    host = store.host();
    const { queued, failedCount } = store.outbox();
    if (host && queued + failedCount > 0 && !force) {
      write(`${queued} outbox entries (checkpoints, executor decisions) still wait for ${host.name} and ${failedCount} were refused by it; leaving deletes them. `
        + 'Deliver them first (`fuli runner sync`, or join the same host again), or leave with --force.');
      return { exitCode: 1 };
    }
    if (host) store.leave();
  } finally {
    store.close();
  }
  if (!host) {
    write('This computer is not a runner; there is nothing to leave.');
    return { exitCode: 0 };
  }
  try {
    rmSync(file, { force: true });
    rmSync(join(dataDir, ROUTING_LEDGER_FILE), { force: true });
  } catch {
    // A client's FULI process has it open: it is empty now and answers that this computer is not paired.
  }
  const identity = await loadDeviceIdentity(join(dataDir, 'peer'));
  write(`Left ${host.name}. The pairing, the answers kept here, the outbox and the executor decisions made here are deleted.`);
  write(`On ${host.name}, \`fuli runner revoke ${identity.fingerprint.slice(0, 16)}\` removes this computer from its list.`);
  write('The clients set up here keep their FULI MCP entry (it now answers that this computer is not paired); '
    + '`fuli uninstall` removes those entries.');
  return { exitCode: 0 };
}

// Delivers what waits in the outbox once, right after a join: the number still
// waiting, or null when the host did not answer.
async function deliverQueued(dataDir) {
  const store = new RunnerStore(join(dataDir, RUNNER_FILE));
  const connection = createHostConnection({ store, identity: await loadDeviceIdentity(join(dataDir, 'peer')) });
  try {
    if (!await connection.connect()) return null;
    return (await deliverOutbox({ store, connection })).queued;
  } finally {
    connection.close();
    store.close();
  }
}

// The clients `fuli setup` would set up here, written with the same entries;
// the MCP entry then serves through the host (src/cli/mcp-command.js).
export async function setUpRunnerClients({ dataDir, env, write, plan = planLocalSetup, apply = applyLocalSetup }) {
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
      // The name the person typed at the invitation, then what the computer calls itself.
      const name = runner.deviceName && runner.deviceName !== runner.name ? `${runner.name} (${runner.deviceName})` : runner.name;
      write(`  ${runner.fingerprint.slice(0, 16)}  ${name}  paired ${runner.pairedAt}  ${runner.revokedAt ? `revoked ${runner.revokedAt}`
        : `last seen ${runner.lastSeenAt ?? 'never'}${runner.lastAddress ? ` from ${runner.lastAddress}` : ''}`}`);
    }
    return { exitCode: 0 };
  }
  const fingerprint = positional(args);
  if (!fingerprint) throw new TypeError(`Missing fingerprint\n${USAGE}`);
  await read(await request('DELETE', `/api/runners/${encodeURIComponent(fingerprint.toLowerCase())}`));
  write('Revoked. That runner can no longer reach this FULI.');
  return { exitCode: 0 };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

// The one value an action takes, by its own position: not a flag and not the
// value of one (indexOf would find the first equal value, so an address or a
// fingerprint that repeats an option's value was read as that option's).
function positional(args, takingValue = []) {
  const valued = ['--data-dir', ...takingValue];
  return args.find((value, index) => !value.startsWith('--') && !valued.includes(args[index - 1]));
}
