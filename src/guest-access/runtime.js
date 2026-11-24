import { discoverGuestAddresses } from '../server/lan-access.js';
import { createGuestRoutes } from './guest-routes.js';
import { startGuestListener } from './listener.js';
import { createRefusalTally } from './refusal-tally.js';

// The console's guest links (rec issue 133, deliverable B): the person creates,
// lists and revokes them, and the guest listener runs exactly while at least
// one link is live. Every change, each link's expiry and, while a link is
// live, a check every REDISCOVER_MS settle the listener again, one settle at a
// time: it ends the MCP sessions of links no longer live, looks up this
// computer's addresses again and rebinds when they changed, and retries after
// no network or a busy port.
const GUEST_PORT = 2729;
// Addresses change when a laptop moves networks or a VPN comes up; a minute is soon enough.
const REDISCOVER_MS = 60 * 1000;

export function createGuestAccess({ visitorAccess, host, port = GUEST_PORT, discoverAddresses = discoverGuestAddresses,
  startListener = startGuestListener, createRoutes = createGuestRoutes, onError = () => {}, now = Date.now }) {
  const links = visitorAccess.guestLinks;
  const refusals = createRefusalTally({ now });
  // The listener and its routes (with their MCP sessions), while a link is live.
  let serving = null;
  let problem = null;
  let timer = null;
  let settling = Promise.resolve();
  let closed = false;

  const settle = () => (settling = settling.then(settleNow, settleNow));

  async function settleNow() {
    clearTimeout(timer);
    try {
      await settleListener();
    } catch (error) {
      problem = 'unavailable';
      onError(error);
    }
  }

  async function settleListener() {
    const liveIds = closed ? [] : links.list().links.map(link => link.id);
    if (!liveIds.length) {
      await stopServing();
      problem = null;
      return;
    }
    const addresses = discoverAddresses();
    if (!addresses.length) {
      await stopServing();
      problem = 'no_network';
    } else if (serving) {
      // A revoked or expired link's MCP sessions end here, not at their idle timeout.
      await serving.routes.keepLinks(liveIds);
      try {
        await serving.listener.rebind(addresses);
        problem = null;
      } catch (error) {
        await stopServing();
        refused(error);
      }
    } else {
      const routes = createRoutes({ visitorAccess, host });
      try {
        serving = { routes, listener: await startListener({ addresses, port, route: routes.handle,
          authenticate: token => links.authenticate(token), onRefused: address => refusals.record(address) }) };
        problem = null;
      } catch (error) {
        await routes.close();
        refused(error);
      }
    }
    const expiry = Date.parse(links.nextExpiry());
    timer = setTimeout(settle, Math.min(Math.max(expiry - now(), 0) + 1, REDISCOVER_MS));
    timer.unref?.();
  }

  async function stopServing() {
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

  // Addresses physical adapters first (discoverGuestAddresses), so the first is the one to offer.
  const status = () => ({ listening: Boolean(serving), addresses: serving?.listener.authorities ?? [], problem,
    refusedToday: refusals.today() });

  return {
    async create({ projectId, days }) {
      try { await host.getProject(projectId); } catch { return { ok: false, code: 'project_unknown' }; }
      const created = links.create({ projectId, days });
      if (created.ok) await settle();
      return created.ok ? { ...created, ...status() } : created;
    },
    list: ({ projectId }) => {
      const listed = links.list({ projectId });
      return listed.ok ? { ...listed, ...status() } : listed;
    },
    async revoke(id) {
      const revoked = links.revoke(id);
      if (revoked.ok) await settle();
      return revoked;
    },
    // Called once the console listens: a link made before a restart serves again.
    start: settle,
    async close() {
      closed = true;
      await settle();
    }
  };
}
