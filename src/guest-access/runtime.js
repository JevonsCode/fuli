import { discoverGuestAddresses } from '../server/lan-access.js';
import { createGuestRoutes } from './guest-routes.js';
import { startGuestListener } from './listener.js';

// The console's guest links (rec issue 133, deliverable B): the person creates,
// lists and revokes them, and the guest listener runs exactly while at least
// one link is live. Every change, and each link's expiry, settles the listener
// again, one settle at a time.
const GUEST_PORT = 2729;
// setTimeout cannot wait longer than about 24.8 days; a later expiry is checked again after a day.
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

export function createGuestAccess({ visitorAccess, host, port = GUEST_PORT, discoverAddresses = discoverGuestAddresses,
  startListener = startGuestListener, onError = () => {}, now = Date.now }) {
  const links = visitorAccess.guestLinks;
  const route = createGuestRoutes({ visitorAccess, host });
  let listener = null;
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
    const live = !closed && links.list().links.length > 0;
    if (live && !listener) {
      const addresses = discoverAddresses();
      if (!addresses.length) problem = 'no_network';
      else {
        try {
          listener = await startListener({ addresses, port, route, authenticate: token => links.authenticate(token) });
          problem = null;
        } catch (error) {
          problem = 'port_unavailable';
          onError(error);
        }
      }
    } else if (!live && listener) {
      const closing = listener;
      listener = null;
      await closing.close();
    }
    if (!live) problem = null;
    const expiry = closed ? null : links.nextExpiry();
    if (expiry) {
      timer = setTimeout(settle, Math.min(Math.max(Date.parse(expiry) - now(), 0) + 1, MAX_WAIT_MS));
      timer.unref?.();
    }
  }

  const status = () => ({ listening: Boolean(listener), addresses: listener?.authorities ?? [], problem });

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
