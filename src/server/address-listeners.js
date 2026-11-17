import { isFetchBlockedPort } from './blocked-ports.js';
import { listenFetchableServer } from './listen.js';

const SHUTDOWN_GRACE_MS = 2000;

// One server per address of this computer, all on one port, following the
// addresses as they change (a laptop that moved networks): rebind closes the
// servers of addresses that are gone and opens the new ones. An address that
// cannot be bound is left out; with none bound rebind throws. The guest link
// listener and the runner listener (docs/runner.md) share it.
export function createAddressListeners({ port, createServer, isBlockedPort = isFetchBlockedPort }) {
  const bound = new Map();
  let order = [];
  let boundPort = port;

  async function rebind(next) {
    order = [...next];
    await Promise.all([...bound].filter(([address]) => !order.includes(address)).map(([address, server]) => {
      bound.delete(address);
      return closeServer(server);
    }));
    let firstError = null;
    for (const address of order.filter((candidate) => !bound.has(candidate))) {
      const server = createServer();
      try {
        await listenFetchableServer(server, boundPort, address, { isBlockedPort });
      } catch (error) {
        firstError ??= error;
        continue;
      }
      boundPort = server.address().port;
      bound.set(address, server);
    }
    if (!bound.size) throw firstError ?? new Error('The listener has no address to bind');
    return bound.size;
  }

  return {
    rebind,
    get port() { return boundPort; },
    get addresses() { return order.filter((address) => bound.has(address)); },
    // The bound addresses with the port, in the order they were given.
    get authorities() { return order.filter((address) => bound.has(address)).map((address) => `${address}:${boundPort}`); },
    close: () => Promise.all([...bound.values()].map(closeServer)).then(() => bound.clear())
  };
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
    setTimeout(() => server.closeAllConnections?.(), SHUTDOWN_GRACE_MS).unref();
  });
}
