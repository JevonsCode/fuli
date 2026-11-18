import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

import { loadDeviceIdentity } from '../../packages/roundtable/src/peer/device-identity.js';
import { discoveryAdapters } from '../../packages/roundtable/src/peer/lan-addresses.js';
import { createBonjourDiscovery } from '../../packages/roundtable/src/peer/nearby-discovery.js';
import { discoverGuestAddresses } from '../server/lan-access.js';
import { startRunnerListener } from './host-listener.js';
import { createRunnerRoutes } from './host-routes.js';
import { RUNNER_HOST_FILE, RunnerHostStore } from './host-store.js';
import { displayName, encodeInvitation, newInvitationCode, RUNNER_PORT, RUNNER_SERVICE_TYPE } from './protocol.js';

// This computer as a host of runners (docs/runner.md). The listener runs
// exactly while a runner is paired or an invitation is live. Every change, an
// invitation's expiry and, while one of them holds, a check every REDISCOVER_MS
// settle it again, one settle at a time: it looks up this computer's addresses
// and rebinds when they changed, ends the sessions of revoked runners, and
// retries after no network or a busy port. A host that never invited opens no
// store, no socket and no timer. While a runner is paired the host announces
// its certificate fingerprint over mDNS (the multicast sockets are open only
// then), so a runner on a network that gave the host another address finds it
// again. close() releases all of it: listener, sessions, mDNS, timer, store.
const REDISCOVER_MS = 60 * 1000;
const DEFAULT_HOST_NAME = 'FULI host';

export function createRunnerHost({ app, dataDir, withLease = (_owner, operation) => operation(),
  port = RUNNER_PORT, hostName = DEFAULT_HOST_NAME, discoverAddresses = discoverGuestAddresses,
  startListener = startRunnerListener, loadIdentity = () => loadDeviceIdentity(join(dataDir, 'peer')),
  createDiscovery = (options) => createBonjourDiscovery(options), consoleOrigin = () => null, onError = () => {},
  now = Date.now }) {
  const store = new RunnerHostStore(join(dataDir, RUNNER_HOST_FILE), { now });
  let identity = null;
  let serving = null;
  let discovery = null;
  let advert = null;
  let problem = null;
  let timer = null;
  let settling = Promise.resolve();
  let closed = false;

  const settle = () => (settling = settling.then(settleNow, settleNow));

  async function settleNow() {
    clearTimeout(timer);
    timer = null;
    let wanted = true;
    try {
      wanted = await settleListener();
    } catch (error) {
      problem = 'unavailable';
      onError(error);
    }
    // Nothing to follow without a runner or an invitation: invite() and pairing settle again.
    if (closed || !wanted) return;
    const expiry = Date.parse(store.nextInvitationExpiry() ?? '');
    const wait = Number.isFinite(expiry) ? Math.min(Math.max(expiry - now(), 0) + 1, REDISCOVER_MS) : REDISCOVER_MS;
    timer = setTimeout(settle, wait);
    timer.unref?.();
  }

  async function settleListener() {
    const wanted = !closed && (store.hasRunners() || store.hasLiveInvitation());
    if (!wanted) {
      await stopServing();
      problem = null;
      return false;
    }
    const addresses = discoverAddresses();
    if (!addresses.length) {
      await stopServing();
      problem = 'no_network';
      return true;
    }
    identity ??= await loadIdentity();
    if (serving) {
      await serving.routes.keepRunners(store.runners().filter((runner) => !runner.revokedAt)
        .map((runner) => runner.fingerprint));
      try {
        await serving.listener.rebind(addresses);
      } catch (error) {
        await stopServing();
        refused(error);
        return true;
      }
    } else {
      const routes = createRunnerRoutes({ app, store, hostName, hostFingerprint: identity.fingerprint, withLease,
        consoleOrigin, onPaired: () => void settle(), now });
      try {
        serving = { routes, listener: await startListener({ identity, addresses, port, route: routes.handle }) };
      } catch (error) {
        await routes.close();
        refused(error);
        return true;
      }
    }
    problem = null;
    announce(store.hasRunners());
    return true;
  }

  function announce(wanted) {
    if (!wanted || !serving) {
      advert?.stop();
      advert = null;
      discovery?.close();
      discovery = null;
      return;
    }
    if (advert) return;
    try {
      discovery ??= createDiscovery({ serviceType: RUNNER_SERVICE_TYPE,
        adapters: () => discoveryAdapters(networkInterfaces), onFailure: (error) => { advert = null; onError(error); } });
      advert = discovery.advertise({ name: `FULI runner host ${identity.fingerprint.slice(0, 8)}`,
        host: `fuli-host-${identity.fingerprint.slice(0, 8)}.local`, port: serving.listener.port,
        txt: { fp: identity.fingerprint } });
    } catch (error) {
      onError(error);
    }
  }

  async function stopServing() {
    announce(false);
    if (!serving) return;
    const closing = serving;
    serving = null;
    await closing.routes.close();
    await closing.listener.close();
  }

  function refused(error) {
    problem = 'port_unavailable';
    onError(error);
  }

  const status = () => ({ listening: Boolean(serving), addresses: serving?.listener.addresses ?? [],
    port: serving?.listener.port ?? port, problem, fingerprint: identity?.fingerprint ?? null });

  return {
    // A one-use invitation for a computer the person names; the listener runs from now on.
    async invite({ name } = {}) {
      const code = newInvitationCode();
      const { expiresAt } = store.invite({ code, name: displayName(name, 'Runner') });
      await settle();
      if (!serving) return { ok: false, code: problem ?? 'unavailable' };
      return { ok: true, expiresAt, invitation: encodeInvitation({ name: hostName, addresses: serving.listener.addresses,
        port: serving.listener.port, certPem: identity.certPem, code }), ...status() };
    },
    list: () => ({ ok: true, runners: store.runners(), ...status() }),
    // fingerprint: the whole fingerprint or a prefix of at least 8 that names one paired runner.
    async revoke(fingerprint) {
      const matches = store.runners().filter((runner) => !runner.revokedAt && typeof fingerprint === 'string'
        && fingerprint.length >= 8 && runner.fingerprint.startsWith(fingerprint));
      if (matches.length !== 1 || !store.revoke(matches[0].fingerprint)) return { ok: false, code: 'runner_unknown' };
      await settle();
      return { ok: true };
    },
    // Called once the console listens: a runner paired before a restart is served again.
    start: settle,
    async close() {
      closed = true;
      await settle();
      store.close();
    }
  };
}
