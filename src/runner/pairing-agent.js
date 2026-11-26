import { Agent } from 'node:https';
import { networkInterfaces } from 'node:os';
import { connect as tlsConnect } from 'node:tls';

import { discoveryAdapters } from '../../packages/roundtable/src/peer/lan-addresses.js';
import { isReachableHostAddress } from '../server/lan-access.js';

// An invitation is spent by its first POST. Select an authenticated TLS socket
// before handing it to HTTP, so competing routes never send the invitation twice.
export function pairedInvitationAgent(tls, { interfaces = networkInterfaces, connect = tlsConnect, timeoutMs = 8000 } = {}) {
  const agent = new Agent({ ...tls, keepAlive: false });
  const normalConnect = agent.createConnection.bind(agent);
  agent.createConnection = (options, callback) => {
    let sources = [];
    if (isReachableHostAddress(options.host)) {
      try { sources = [...new Set(discoveryAdapters(interfaces))]; } catch { /* use the system route */ }
    }
    if (!sources.length) return normalConnect(options, callback);
    const sockets = [];
    const timeout = setTimeout(() => {
      for (const socket of sockets) socket.destroy(new Error('Pairing connection timed out'));
    }, timeoutMs);
    const attempts = [undefined, ...sources].map(localAddress => new Promise((resolve, reject) => {
      const socket = connect({ ...options, ...tls, localAddress });
      sockets.push(socket);
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('Pairing socket closed before TLS completed')));
      socket.once('secureConnect', () => resolve(socket));
    }));
    Promise.any(attempts).then(winner => finish(null, winner), error => finish(error));
    function finish(error, winner) {
      clearTimeout(timeout);
      for (const socket of sockets) if (socket !== winner) socket.destroy();
      callback(error, winner);
    }
  };
  return agent;
}
