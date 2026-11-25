import { existsSync, rmSync } from 'node:fs';
import { Agent } from 'node:https';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { loadDeviceIdentity } from '../../packages/roundtable/src/peer/device-identity.js';
import { pinnedTls } from '../../packages/roundtable/src/peer/peer-transport.js';
import { ApplicationError } from '../app/application-error.js';
import { graphHoldsNothingOfThePerson, PREPARING_WAIT, readLocalRuntime } from './follower-local-runtime.js';
import { pinnedFetch } from './host-connection.js';
import { localRegistryDescriptor } from './project-creation.js';
import { installationRecord } from './project-installation.js';
import { displayName, parseInvitation, RUNNER_PATHS } from './protocol.js';
import { hostOwner, ROUTES_FILE, RoutesStore } from './routes-store.js';
import { LEFT_MARKER } from './runner-mode.js';
import { RUNNER_FILE, RunnerStore } from './runner-store.js';

// Pairs this computer as a runner (docs/runner.md) with the host that printed
// the invitation: at each address it names, TLS pinned to the host's
// certificate, presenting this device's own with the invitation's code. The
// host records this device only when the code holds; this side records the
// host only when the host said so.
const PAIR_TIMEOUT_MS = 8000;

// force: join another host although checkpoints for the current one still wait
// or were refused; joining drops them (runner-store.js saveHost).
export async function joinHost({ dataDir, invitation: text, name = null, force = false,
  loadIdentity = () => loadDeviceIdentity(join(dataDir, 'peer')) }) {
  // A graph this computer prepared for itself while it followed a host, with nothing of the person's in it
  // (follower-local-runtime.js), hides nothing: joining again (after a revoke, or `fuli runner leave`) works.
  const prepared = existsSync(join(dataDir, 'graph-runtime.json')) ? readLocalRuntime(dataDir) : null;
  if (prepared?.state === 'preparing') {
    throw new ApplicationError('local_runtime_preparing', `${PREPARING_WAIT.en}\n${PREPARING_WAIT.zh}`);
  }
  if (prepared && !graphHoldsNothingOfThePerson(prepared)) {
    throw new ApplicationError('runner_has_own_fuli', 'This data directory holds a FULI of its own, and joining a host '
      + 'follows it for everything, which would hide that FULI. Owning some of your FULI here and following another '
      + 'computer for the rest is a later step (docs/runner-roles-design.md); until then, join from a data directory '
      + 'without a FULI setup (--data-dir).');
  }
  const host = parseInvitation(text);
  const registry = localRegistryDescriptor(dataDir);
  const installation = installationRecord(dataDir);
  if ((registry && registry.authority !== host.fingerprint) || (installation && installation.authority !== host.fingerprint)) {
    throw new ApplicationError('project_registry_pairing_changed',
      'This installation holds projects registered with another host. Reconnect to that host or use a separate data directory. '
      + '本机项目已登记在另一台主机，请连接原主机或使用单独的数据目录。');
  }
  // Before the one-use invitation is spent: a join that would drop checkpoints needs --force.
  if (!force) refuseDroppingCheckpoints(dataDir, host.fingerprint);
  const identity = await loadIdentity();
  const agent = new Agent({ ...pinnedTls(identity, host), keepAlive: false });
  const fetch = pinnedFetch(agent);
  try {
    for (const address of host.addresses) {
      let answer;
      try {
        answer = await fetch(`https://${address}:${host.port}${RUNNER_PATHS.pair}`, { method: 'POST',
          headers: { 'content-type': 'application/json' },
          // What this computer calls itself; the host shows it beside the name the person gave the invitation.
          body: JSON.stringify({ code: host.code, name: displayName(name ?? hostname(), '') }), signal: AbortSignal.timeout(PAIR_TIMEOUT_MS) });
      } catch {
        continue;
      }
      const body = await answer.json().catch(() => null);
      if (answer.status !== 200) {
        throw new ApplicationError('invitation_invalid', answer.status === 429
          ? 'The host refused too many attempts from this computer; wait ten minutes and ask it for a new invitation.'
          : 'The host did not accept this invitation: it was used, expired or not this host\'s. Run `fuli runner invite` on the host '
            + 'again. If you did not use it, someone else may have: check `fuli runner list` on the host and '
            + '`fuli runner revoke` a computer you do not know.');
      }
      // A pairing ended earlier by `leave` while its store was held open is over: this one starts.
      rmSync(join(dataDir, LEFT_MARKER), { force: true });
      const store = new RunnerStore(join(dataDir, RUNNER_FILE));
      let kept;
      try {
        kept = store.saveHost({ name: displayName(body?.name, host.name), fingerprint: host.fingerprint, certPem: host.certPem,
          port: host.port, addresses: host.addresses, lastAddress: address });
      } finally {
        store.close();
      }
      // `fuli runner join` is 「follow everything」 on this host (docs/runner-roles-design.md §3).
      const routes = new RoutesStore(join(dataDir, ROUTES_FILE));
      try {
        routes.joined(hostOwner(host.fingerprint));
      } finally {
        routes.close();
      }
      // outbox: checkpoints a join to another host dropped, or a join to the same host queued again.
      return { host: { name: displayName(body?.name, host.name), fingerprint: host.fingerprint, address, port: host.port },
        runner: { fingerprint: identity.fingerprint }, outbox: kept };
    }
  } finally {
    agent.destroy();
  }
  throw new ApplicationError('host_unreachable', 'The host did not answer at any address in the invitation. '
    + 'Both computers must share a network (the same Wi-Fi or a cable), and the host\'s FULI console must be running.');
}

function refuseDroppingCheckpoints(dataDir, fingerprint) {
  const file = join(dataDir, RUNNER_FILE);
  if (!existsSync(file)) return;
  const store = new RunnerStore(file);
  try {
    const current = store.host();
    if (!current || current.fingerprint === fingerprint) return;
    const { queued, failedCount } = store.outbox();
    if (queued + failedCount === 0) return;
    throw new ApplicationError('runner_checkpoints_waiting', `${queued} checkpoint(s) still wait for ${current.name} and `
      + `${failedCount} were refused by it; joining another host deletes them. Deliver them first (\`fuli runner sync\`, `
      + 'or join the same host again), or join with --force. The invitation was not used.');
  } finally {
    store.close();
  }
}
