import { existsSync } from 'node:fs';
import { Agent } from 'node:https';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { loadDeviceIdentity } from '../../packages/roundtable/src/peer/device-identity.js';
import { pinnedTls } from '../../packages/roundtable/src/peer/peer-transport.js';
import { ApplicationError } from '../app/application-error.js';
import { pinnedFetch } from './host-connection.js';
import { displayName, parseInvitation, RUNNER_PATHS } from './protocol.js';
import { RUNNER_FILE, RunnerStore } from './runner-store.js';

// Pairs this computer as a runner (docs/runner.md) with the host that printed
// the invitation: at each address it names, TLS pinned to the host's
// certificate, presenting this device's own with the invitation's code. The
// host records this device only when the code holds; this side records the
// host only when the host said so.
const PAIR_TIMEOUT_MS = 8000;

export async function joinHost({ dataDir, invitation: text, name = null,
  loadIdentity = () => loadDeviceIdentity(join(dataDir, 'peer')) }) {
  if (existsSync(join(dataDir, 'graph-runtime.json'))) {
    throw new ApplicationError('runner_has_own_fuli', 'This data directory runs its own FULI. '
      + 'A runner keeps nothing of its own; join from a computer (or --data-dir) without a FULI setup.');
  }
  const host = parseInvitation(text);
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
      const store = new RunnerStore(join(dataDir, RUNNER_FILE));
      try {
        store.saveHost({ name: displayName(body?.name, host.name), fingerprint: host.fingerprint, certPem: host.certPem,
          port: host.port, addresses: host.addresses, lastAddress: address });
      } finally {
        store.close();
      }
      return { host: { name: displayName(body?.name, host.name), fingerprint: host.fingerprint, address, port: host.port },
        runner: { fingerprint: identity.fingerprint } };
    }
  } finally {
    agent.destroy();
  }
  throw new ApplicationError('host_unreachable', 'The host did not answer at any address in the invitation. '
    + 'Both computers must share a network (the same Wi-Fi or a cable), and the host\'s FULI console must be running.');
}
