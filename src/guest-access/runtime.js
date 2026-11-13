import { discoverGuestAddresses } from '../server/lan-access.js';
import { createGuestRoutes } from './guest-routes.js';
import { startGuestListener } from './listener.js';

// The console's guest links (rec issue 133, deliverable B): the person creates,
// lists and revokes them, and the guest listener runs exactly while at least
// one link is live. Every change, and each link's expiry, settles the listener
// again, one settle at a time, and ends the MCP sessions of links no longer live.
const GUEST_PORT = 2729;
// setTimeout cannot wait longer than about 24.8 days; a later expiry is checked again after a day.
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

export function createGuestAccess({ visitorAccess, host, port = GUEST_PORT, discoverAddresses = discoverGuestAddresses,
  startListener = startGuestListener, createRoutes = createGuestRoutes, onError = () => {}, now = Date.now }) {
  const links = visitorAccess.guestLinks;
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
    const live = liveIds.length > 0;
    // A revoked or expired link's MCP sessions end here, not at their idle timeout.
    if (live && serving) await serving.routes.keepLinks(liveIds);
    if (live && !serving) {
      const addresses = discoverAddresses();
      if (!addresses.length) problem = 'no_network';
      else {
        const routes = createRoutes({ visitorAccess, host });
        try {
          serving = { routes, listener: await startListener({ addresses, port, route: routes.handle,
            authenticate: token => links.authenticate(token) }) };
          problem = null;
        } catch (error) {
          await routes.close();
          problem = 'port_unavailable';
          onError(error);
        }
      }
    } else if (!live && serving) {
      const closing = serving;
      serving = null;
      await closing.routes.close();
      await closing.listener.close();
    }
    if (!live) problem = null;
    const expiry = closed ? null : links.nextExpiry();
    if (expiry) {
      timer = setTimeout(settle, Math.min(Math.max(Date.parse(expiry) - now(), 0) + 1, MAX_WAIT_MS));
      timer.unref?.();
    }
  }

  const status = () => ({ listening: Boolean(serving), addresses: serving?.listener.authorities ?? [], problem });

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
