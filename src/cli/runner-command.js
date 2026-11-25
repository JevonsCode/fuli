import { holdBackupOwnership } from '../runner/project-write-gate.js';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadDeviceIdentity } from '../../packages/roundtable/src/peer/device-identity.js';
import { createHostConnection } from '../runner/host-connection.js';
import { joinHost } from '../runner/join.js';
import { deliverOutbox } from '../runner/outbox-delivery.js';
import { ROUTES_FILE } from '../runner/routes-store.js';
import { RUNNER_EXECUTORS_FILE } from '../runner/routing-executors.js';
import { ROUTING_LEDGER_FILE, RoutingLedger } from '../runner/routing-ledger.js';
import { MODEL_BACKENDS_FILE } from '../runner/routing-setup.js';
import { isReachableHostAddress } from '../server/lan-access.js';
import { mcpSessionsLine } from '../runner/protocol.js';
import { versionSkewLine } from '../runner/version-skew.js';
import { PROJECT_IDENTITY_CACHE_FILE } from '../system/project-identity-cache.js';
import { LEFT_MARKER } from '../runner/runner-mode.js';
import { RUNNER_FILE, RunnerStore } from '../runner/runner-store.js';
import { parseSetupOptions } from '../setup/options.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { applyLocalSetup, planLocalSetup } from '../setup/setup.js';
import { localConsoleUrl } from './console-url.js';
import { capabilityLines, ownSideLines, serveFollowerConsole } from '../runner/follower-runtime.js';
import { setAsideHostCopy } from '../runner/leave-global-copy.js';
import { followerStatus, keptLine } from '../runner/follower-status.js';
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
    retire-inventory FINGERPRINT  retire a revoked, unchecked computer permanently, keeping its known project IDs
    status                        the host, whether it answers, and the outbox
    sync                          deliver the outbox now
    add-address ADDRESS           where the host is now, when this computer cannot find it by
                                  itself (another subnet, as in an office); kept for next time,
                                  then the outbox is delivered as with sync
    leave [--force]               end the pairing here and delete what is kept here
                                  (--force: also when checkpoints never reached the host)
    console [--port PORT]         serve this computer's console: its own state, and the host's
                                  pages over the pairing (fuli start runs it)
    prepare-local                 prepare this computer's own runtime (Neo4j and the Provider), check
                                  that it starts, and stop it again while no scope is this computer's
                                  (the console runs it in the background; nothing is routed to it yet)
  Every action takes --data-dir DIR.`;
// What a runner keeps (runner-store.js), said where it pairs.
const KEPT_HERE = 'Kept here: the host\'s last answers to read-only calls (shown, marked offline, while the host is away; '
  + 'nothing is deleted because it is old: past 5000 answers or 64 MB the ones used longest ago go) and checkpoints '
  + 'waiting for the host (deleted once delivered; a refused one stays listed). A task token given out while the host is '
  + 'away lasts 30 days. If the host revokes this computer, the answers go at once and the checkpoints wait, refused, '
  + 'until it joins the same host again. Nothing else of FULI\'s knowledge is stored here; `fuli runner leave` deletes it all.';
const JOIN_AGAIN = 'Join again: `fuli runner invite` on the host, then `fuli runner join INVITATION` here.';

export async function runRunnerCommand(args, { env = process.env, fetchImpl = fetch, write = writeLine,
  join: joinRunner = joinHost, setupClients = setUpRunnerClients, remove = rmSync, setAsideCopy = setAsideHostCopy } = {}) {
  const [action, ...rest] = args;
  const dataDir = option(rest, '--data-dir');
  const paths = () => resolveSetupPaths({ dataDir, env });
  if (!action || action === '--help' || action === '-h') return void write(USAGE);
  if (action === 'invite' || action === 'list' || action === 'revoke' || action === 'allow' || action === 'retire-inventory') {
    return consoleAction(action, rest, { baseUrl: localConsoleUrl({ dataDir, env }), fetchImpl, write });
  }
  if (action === 'join') {
    const invitation = positional(rest, ['--name']);
    if (!invitation) throw new TypeError(`Missing invitation\n${USAGE}`);
    const joined = await joinRunner({ dataDir: paths().dataDir, invitation, name: option(rest, '--name') ?? null,
      force: rest.includes('--force') });
    // Who owns a project is the host's answer: what an earlier pairing said does not carry over.
    remove(join(paths().dataDir, PROJECT_IDENTITY_CACHE_FILE), { force: true });
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
  if (action === 'prepare-local') {
    const { prepareFollowerRuntime } = await import('../runner/follower-runtime-prepare.js');
    const record = await prepareFollowerRuntime({ dataDir: paths().dataDir, env, write });
    return { exitCode: record?.state === 'ready' || record?.state === 'preparing' ? 0 : 1 };
  }
  if (action === 'leave') {
    const directory = paths().dataDir;
    const ownership = holdBackupOwnership(directory, false);
    try {
      return await leaveHost(directory, write, { force: rest.includes('--force'), remove,
        setAsideCopy: finish => setAsideCopy(paths(), { env, finish }) });
    } finally { ownership?.release(); }
  }
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
        write(`Last reached: ${state.host.lastSeenAt ?? 'never'}.`);
        if (!reached && !named) {
          write('In another subnet (an office network, say) this computer cannot find the host by itself: '
            + '`fuli runner add-address ADDRESS` with the host\'s address, which `fuli runner list` shows there.');
        }
        if (state.host.mcpSessions) write(mcpSessionsLine(state.host.mcpSessions));
        // Neither side is blocked; the person is only told which copy is older (rec#144).
        if (state.versions?.skew) write(versionSkewLine(state.versions.skew, state.host.name));
        if (state.host.pinFailed) {
          write(`Something answered at ${host.name}'s address with another certificate than the paired one. `
            + `If the host was reinstalled, join again. ${JOIN_AGAIN}`);
        }
        const delivering = action !== 'status' && reached;
        const outbox = delivering ? await deliverOutbox({ store, connection, dataDir: paths().dataDir }) : state.outbox;
        if (delivering) write(`Delivered ${outbox.delivered}, refused ${outbox.refused}.`);
        write(`Outbox: ${outbox.queued} waiting${outbox.failed.length ? `, ${outbox.failed.length} refused by the host` : ''}.`);
        for (const entry of outbox.failed) write(`  ${entry.queuedAt} ${entry.tool}: ${entry.reason}`);
        for (const line of ownSideLines(state)) write(line);
        for (const line of capabilityLines(state.capabilities)) write(line);
        write(keptLine(state.cache).en);
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
async function leaveHost(dataDir, write, { force = false, remove = rmSync, setAsideCopy = async () => null } = {}) {
  const file = join(dataDir, RUNNER_FILE);
  const store = new RunnerStore(file);
  let host;
  let aside = null;
  try {
    host = store.host();
    const { queued, failedCount } = store.outbox();
    if (host && queued + failedCount > 0 && !force) {
      write(`${queued} outbox entries (checkpoints, executor decisions) still wait for ${host.name} and ${failedCount} were refused by it; leaving deletes them. `
        + 'Deliver them first (`fuli runner sync`, or join the same host again), or leave with --force.');
      return { exitCode: 1 };
    }
    if (host) {
      // The host's copy of global goes aside first (leave-global-copy.js); when it cannot now, nothing changes.
      try {
        aside = await setAsideCopy(released => {
          store.leave();
          if (released) writeFileSync(join(dataDir, LEFT_MARKER), `${new Date().toISOString()}\n`);
        });
      } catch (error) {
        write(`${String(error?.message ?? error)} Nothing was changed; this computer still follows ${host.name}.`);
        return { exitCode: 1 };
      }
      if (store.host()) store.leave();
    }
  } finally {
    store.close();
  }
  if (!host) {
    write('This computer is not a runner; there is nothing to leave.');
    return { exitCode: 0 };
  }
  // Each file on its own: on Windows one a client's FULI MCP process still has
  // open cannot be deleted, and that must not stop the other or be said as done.
  // The store was emptied above, so what is left of it holds nothing; while it
  // stays, the marker says the pairing ended, so this computer is not taken for
  // a follower. A ledger that stays needs none: the store decides that.
  const storeGone = removed(file, remove);
  if (!storeGone) writeFileSync(join(dataDir, LEFT_MARKER), `${new Date().toISOString()}\n`);
  const stayed = [
    storeGone ? null : `${RUNNER_FILE}: emptied, so it holds nothing of the pairing any more`,
    removed(join(dataDir, ROUTING_LEDGER_FILE), remove) ? null : emptiedLedger(join(dataDir, ROUTING_LEDGER_FILE)),
    // Its routes named that host: with the pairing gone, this computer owns everything it has again.
    removed(join(dataDir, ROUTES_FILE), remove) ? null : `${ROUTES_FILE}: still holds the routes to that host`
  ].filter(Boolean);
  // The host's last `fuli whoami` answers belonged to its knowledge too. A JSON
  // file no process keeps open: if it stays anyway, a new pairing overwrites it.
  removed(join(dataDir, PROJECT_IDENTITY_CACHE_FILE), remove);
  const identity = await loadDeviceIdentity(join(dataDir, 'peer'));
  write(stayed.length
    ? `Left ${host.name}. A FULI process of a client here still has these files open, so they could not be deleted:`
    : `Left ${host.name}. The pairing, the answers kept here, the outbox, the executor decisions made here and the routes to it are deleted.`);
  for (const line of stayed) write(`  ${line}`);
  if (stayed.length) write('Close the clients here, then delete those files yourself if you want them gone.');
  if (aside?.released) {
    write(`The host replica was released. Local projects remain here. Full offline backup: ${aside.folder}.`);
    // Counted before the release; said only when there are some (null: they could not be counted).
    const waiting = aside.waitingRecruitments;
    if (waiting === null || waiting === undefined) {
      write('Recruitments that were waiting for the former host to make their FLA could not be counted; any still '
        + 'blocked have to be cancelled and requested again on this computer.');
    } else if (waiting > 0) {
      write(`${waiting} recruitment(s) were waiting for the former host to make their FLA; cancel them and request `
        + 'them again on this computer.');
    }
  } else if (aside) {
    write(`This computer's graph held only ${host.name}'s copy of global; it was set aside, not deleted, in ${aside.folder}. `
      + 'The next start makes a graph of this computer\'s own.');
  }
  // The person wrote these two; FULI never does, so it does not delete them either.
  const own = [MODEL_BACKENDS_FILE, RUNNER_EXECUTORS_FILE].filter((file) => existsSync(join(dataDir, file)));
  if (own.length) {
    write(`${own.join(' and ')} stay as you wrote them. They do nothing now (every call answers that this computer `
      + 'is not paired); delete them yourself if this computer should no longer judge executors.');
  }
  write(`On ${host.name}, \`fuli runner revoke ${identity.fingerprint.slice(0, 16)}\` removes this computer from its list.`);
  write('The clients set up here keep their FULI MCP entry (it now answers that this computer is not paired); '
    + '`fuli uninstall` removes those entries.');
  return { exitCode: 0 };
}

// Whether the file is gone now (or never was). remove: rmSync, or a test's stand-in.
function removed(path, remove) {
  try {
    remove(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

// The decision ledger emptied in place, for when the file itself could not be
// deleted; what the person reads about it either way.
function emptiedLedger(path) {
  const ledger = new RoutingLedger(path);
  try {
    ledger.clear();
    return `${ROUTING_LEDGER_FILE}: emptied, so the executor decisions made here are gone`;
  } catch {
    return `${ROUTING_LEDGER_FILE}: still holds the executor decisions made here; delete it once the clients are closed`;
  } finally {
    ledger.close();
  }
}

// Delivers what waits in the outbox once, right after a join: the number still
// waiting, or null when the host did not answer.
async function deliverQueued(dataDir) {
  const store = new RunnerStore(join(dataDir, RUNNER_FILE));
  const connection = createHostConnection({ store, identity: await loadDeviceIdentity(join(dataDir, 'peer')) });
  try {
    if (!await connection.connect()) return null;
    return (await deliverOutbox({ store, connection, dataDir })).queued;
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
  if (action === 'retire-inventory') {
    const fingerprint = positional(args, []);
    if (!/^[a-f0-9]{64}$/.test(fingerprint ?? '')) throw new TypeError('Use runner retire-inventory FINGERPRINT');
    const path = `/api/runners/${fingerprint}/historical-inventory`;
    const current = await read(await request('GET', path));
    await read(await request('POST', path, { pairing: current.pairing }));
    write('The revoked computer is retired. Its known project IDs are reserved.');
    return { exitCode: 0 };
  }
  if (action === 'allow') {
    const fingerprint = positional(args, ['--scope']);
    const scope = option(args, '--scope');
    if (!/^[a-f0-9]{64}$/.test(fingerprint ?? '') || !scope) throw new TypeError('Use runner allow FINGERPRINT --scope SCOPE');
    const path = `/api/runners/${fingerprint}/grants`;
    const current = await read(await request('GET', path));
    const version = current.scopes.find(row => row.scope === scope)?.version ?? 0;
    const state = args.includes('--revoke') ? 'revoked' : 'allowed';
    await read(await request('POST', path, { scope, state, version, pairing: current.pairing }));
    write(`${scope}: ${state}`);
    return { exitCode: 0 };
  }
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
