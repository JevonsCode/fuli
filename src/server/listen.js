import { isFetchBlockedPort } from './blocked-ports.js';

const FETCHABLE_PORT_ATTEMPTS = 20;

export function listenServer(server, port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

// fetch() refuses a fixed list of ports. A listener that fetch-based clients
// must reach rejects such a configured port and rebinds an ephemeral one that
// the operating system happened to pick from that list.
export async function listenFetchableServer(
  server,
  port,
  host = '127.0.0.1',
  { isBlockedPort = isFetchBlockedPort, attempts = FETCHABLE_PORT_ATTEMPTS } = {}
) {
  if (Number(port) !== 0) {
    if (isBlockedPort(port)) throw new Error(`Port ${port} is blocked for local fetch`);
    await listenServer(server, port, host);
    return;
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await listenServer(server, port, host);
    const address = server.address();
    if (typeof address !== 'object' || !address || !isBlockedPort(address.port)) return;
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error(`No port outside the fetch block list was available after ${attempts} attempts`);
}
