import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRoundtableService } from './service.js';
import { handleRoundtableApiRequest, handleRoundtablePeerRequest } from './http-router.js';
import { handleRoundtableMcpRequest } from './mcp-server.js';
import { serveStatic } from '../http/static-handler.js';
import { sendJson } from '../http/response.js';
import { localServerAuthority, rejectRequestOutsidePolicy } from '../http/request-policy.js';
import { mapHttpError } from '../http/error-mapping.js';

export async function createRoundtableServer({ dataDir, service: configuredService,
  port = 3738, host = '127.0.0.1', allowedHosts = [] } = {}) {
  if (!configuredService && !dataDir) throw new TypeError('Roundtable data directory required');
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const service = configuredService ?? createRoundtableService({ databasePath: join(dataDir, 'roundtables.sqlite') });
  let authority;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/roundtable-peer/')) {
        // A public reverse proxy must preserve an explicitly allowed Host.
        if (![authority, ...allowedHosts].includes(request.headers.host) || request.headers.origin) {
          sendJson(response, 403, { error: 'Peer authority forbidden' }); return;
        }
        if (await handleRoundtableMcpRequest({ request, response, url, service }) ||
            await handleRoundtablePeerRequest({ request, response, url, service })) return;
        sendJson(response, 404, { error: 'Peer route not found' }); return;
      }
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
      if (!local || rejectRequestOutsidePolicy({ request, response, authority })) {
        if (!response.writableEnded) sendJson(response, 403, { error: 'Owner console is local only' }); return;
      }
      if (url.pathname === '/api/health') { sendJson(response, 200, { status: 'ready', service: 'fuli-roundtable' }); return; }
      if (await handleRoundtableApiRequest({ request, response, url, service })) return;
      if (url.pathname.startsWith('/api/')) { sendJson(response, 404, { error: 'Only Roundtable APIs are available on this coordinator' }); return; }
      serveStatic(url.pathname, response);
    })().catch((error) => {
      if (response.headersSent || response.destroyed) return;
      const mapped = error.status ? { status: error.status, body: { error: error.message, code: error.code } } : mapHttpError(error);
      sendJson(response, mapped.status, mapped.body);
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    authority = localServerAuthority(server.address());
  } catch (error) { if (!configuredService) service.close(); throw error; }
  let closing;
  return { server, service, url: `http://${authority}`,
    close: () => closing ??= new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      .finally(() => { if (!configuredService) service.close(); }) };
}
