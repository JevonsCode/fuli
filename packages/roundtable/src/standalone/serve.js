import { createServer } from 'node:http';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { handlePeerControlRequest } from '../peer/control.js';
import { createPeerRuntime } from '../peer/peer-runtime.js';

export const DEFAULT_SERVE_PORT = 2737;
const BODY_LIMIT = 256 * 1024;

const servePath = home => join(home, 'serve.json');

export function serveAddress(home) {
  try {
    const { port } = JSON.parse(readFileSync(servePath(home), 'utf8'));
    return Number.isSafeInteger(port) ? `http://127.0.0.1:${port}` : null;
  } catch { return null; }
}

function readJson(request) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) { reject(new Error('Request body is too large')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

// Keeps the LAN roundtable of a standalone home running: it resumes whatever
// the owner turned on and answers the owner's controls on loopback only.
export async function startStandaloneServe({ standalone, port = DEFAULT_SERVE_PORT, onError = () => {} }) {
  const runtime = createPeerRuntime({ host: standalone.host, roundtable: standalone.roundtable, port: standalone.peer, onError });
  await runtime.resume().catch(onError);
  const server = createServer((request, response) => {
    handlePeerControlRequest({ request, response, url: new URL(request.url, 'http://127.0.0.1'), peer: runtime,
      readJson, sendJson, unavailableMessage: 'The LAN roundtable is not available' })
      .then(handled => { if (!handled) sendJson(response, 404, { error: 'not_found', message: 'Unknown route' }); })
      .catch(error => sendJson(response, 400, { error: 'invalid_request', message: error.message }));
  });
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolveListen));
  const address = server.address();
  writeFileSync(servePath(standalone.home), JSON.stringify({ port: address.port, pid: process.pid }));
  return { port: address.port, async close() {
    rmSync(servePath(standalone.home), { force: true });
    await new Promise(resolveClose => server.close(resolveClose));
    await runtime.close();
  } };
}
