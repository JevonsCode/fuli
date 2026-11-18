import { isLoopbackAddress } from './request-policy.js';
import { readJson, sendJson } from './response.js';

// 客户端接入: the clients on this computer, FULI's entries in them, and the
// ones the person adds by hand. `system` is the console's system service, or
// on a runner its own client service (src/runner/runner-clients.js), so a
// runner's page lists and connects the runner's clients, not the host's.
// Changing a client is the person's step on this computer only.
export async function handleClientConnectionRequest({ request, response, url, system }) {
  if (url.pathname === '/api/system/client-connection' && request.method === 'GET') {
    response.setHeader('Cache-Control', 'no-store');
    sendJson(response, 200, system.clientConnection());
    return true;
  }

  if (url.pathname === '/api/system/client-connection/connect' && request.method === 'POST') {
    response.setHeader('Cache-Control', 'no-store');
    if (!isLoopbackAddress(request.socket?.remoteAddress)) {
      sendJson(response, 403, { error: 'Client connection is only available on this computer' });
      return true;
    }
    sendJson(response, 200, await system.connectClient(await readJson(request)));
    return true;
  }

  // Quitting and reopening a client app ends its open sessions: only the person on this computer starts it.
  if (url.pathname === '/api/system/client-connection/restart' && request.method === 'POST') {
    response.setHeader('Cache-Control', 'no-store');
    if (!isLoopbackAddress(request.socket?.remoteAddress)) {
      sendJson(response, 403, { error: 'Restarting a client is only available on this computer' });
      return true;
    }
    sendJson(response, 200, await system.restartClient(await readJson(request)));
    return true;
  }

  if (url.pathname === '/api/system/client-connection/status' && request.method === 'GET') {
    response.setHeader('Cache-Control', 'no-store');
    sendJson(response, 200, await system.clientConnectionStatus());
    return true;
  }

  // A client the person describes by hand goes into the shared agent-clients
  // directory, so only this computer may add or remove one.
  const customClient = /^\/api\/system\/client-connection\/custom-clients(?:\/([a-z][a-z0-9-]{0,63}))?$/.exec(url.pathname);
  if (customClient && ((request.method === 'POST' && !customClient[1]) || (request.method === 'DELETE' && customClient[1]))) {
    response.setHeader('Cache-Control', 'no-store');
    if (!isLoopbackAddress(request.socket?.remoteAddress)) {
      sendJson(response, 403, { error: 'Custom clients can only be changed on this computer' });
      return true;
    }
    sendJson(response, 200, request.method === 'POST'
      ? await system.addCustomClient(await readJson(request))
      : await system.removeCustomClient(customClient[1]));
    return true;
  }
  return false;
}
