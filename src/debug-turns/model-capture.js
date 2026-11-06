import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { buildModelRequestRecord } from './record.js';
import { opensTurn, requestParts, usageFrom } from './model-request.js';

// Debug: a local proxy between a client and its model API, so the person can
// read the whole request, which a hook can't see (Jevons 11-04). Off until the
// person turns it on in the hidden Debug page, and off again after a restart.
// It listens on this computer only and forwards everything unchanged; it writes
// no log and no file of its own. The request that opens a turn becomes a Debug
// record, secrets masked. Request headers are never kept.
const MODEL_CAPTURE_PORT = 8788;
const UPSTREAM = 'https://api.anthropic.com';
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding']);

function keepTurn(store, sourceApplication, body, answer) {
  try {
    const parsed = JSON.parse(body);
    if (opensTurn(parsed)) store.write(buildModelRequestRecord({ sourceApplication, ...requestParts(parsed, usageFrom(answer)) }));
  } catch { /* A request that cannot be read is still forwarded; capture never changes the turn. */ }
}

function forwarding({ store, upstream, send }) {
  const target = new URL(upstream);
  return (incoming, outgoing) => {
    // A web page may reach this port too; only a client on this computer is served.
    if (incoming.headers.origin) {
      outgoing.writeHead(403);
      outgoing.end();
      return;
    }
    const chunks = [];
    incoming.on('data', chunk => chunks.push(chunk));
    incoming.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => !HOP_HEADERS.has(name)));
      const forward = send({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
        path: incoming.url, method: incoming.method,
        // Identity, so usage can be read from the answer as it passes through.
        headers: { ...headers, host: target.host, 'accept-encoding': 'identity', 'content-length': body.length } }, (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        const seen = [];
        answer.on('data', (chunk) => { seen.push(chunk); outgoing.write(chunk); });
        answer.on('end', () => {
          outgoing.end();
          if (incoming.method === 'POST' && /\/messages(\?|$)/.test(incoming.url ?? '')) {
            keepTurn(store, 'claude_code', body.toString('utf8'), Buffer.concat(seen).toString('utf8'));
          }
        });
      });
      forward.on('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      forward.end(body);
    });
  };
}

export function createModelCapture({ store, upstream = UPSTREAM, port = MODEL_CAPTURE_PORT, send = httpsRequest }) {
  let server = null;
  const status = () => ({ on: Boolean(server), port: server?.address()?.port ?? port });
  return {
    status,
    async set(on) {
      if (on === Boolean(server)) return status();
      if (!on) {
        const closing = server;
        server = null;
        await new Promise(done => { closing.close(done); closing.closeAllConnections?.(); });
        return status();
      }
      const starting = createServer(forwarding({ store, upstream, send }));
      await new Promise((resolve, reject) => {
        starting.once('error', reject);
        starting.listen(port, '127.0.0.1', resolve);
      });
      server = starting;
      return status();
    },
    close() { return this.set(false); },
  };
}
