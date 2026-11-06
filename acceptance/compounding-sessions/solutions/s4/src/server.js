import { createServer } from 'node:http';
import { channels } from './channels/index.js';
import { logLine } from './log.js';
import { relay } from './relay.js';

async function readJson(request) {
  let text = '';
  for await (const chunk of request) text += chunk;
  return JSON.parse(text || '{}');
}

function reply(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export function handler(transports) {
  return async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      return reply(response, 200, { status: 'ok', channels: Object.keys(channels).sort() });
    }
    if (request.method === 'POST' && request.url === '/relay') {
      try {
        const message = await readJson(request);
        const result = await relay(message, { transports });
        logLine('relayed', { channel: message.channel, id: result.id });
        return reply(response, 202, result);
      } catch (error) {
        logLine('failed', { error: error.message });
        return reply(response, 400, { error: error.code ?? 'unknown', message: error.message });
      }
    }
    return reply(response, 404, { error: 'not found' });
  };
}

export function start({ port, transports = {} }) {
  const server = createServer(handler(transports));
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
