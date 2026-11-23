import { once } from 'node:events';
import { request as httpRequest } from 'node:http';

import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { createRemoteMcpHttpServer } from '../src/mcp/remote-http-server.js';

// What the remote MCP HTTP server tests share (remote-mcp-server, -sessions,
// -shutdown): a server on a free loopback port with a synthetic token, the
// requests they send, and hooks that let a test order its work after a point
// the server has reached.

export const TOKEN = 'synthetic-remote-mcp-token-1234567890';
// A shutdown grace twice the test timeout. Tests that exercise ordering or the
// drain use it so a loaded scheduler can never reach the forced close first;
// close() still settles as soon as the connections end.
export const UNREACHED_GRACE_MS = 10_000;

export function initializeBody(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fuli-remote-test', version: '1.0.0' }
    }
  };
}

// Resolves once the server has parsed the headers of the matching request and
// its handler has started, so a test can order work after that point.
export function serverRequest(remote, matches = () => true) {
  return new Promise((resolve) => {
    const onRequest = (request, response) => {
      if (!matches(request)) return;
      remote.server.off('request', onRequest);
      resolve({ request, response });
    };
    remote.server.on('request', onRequest);
  });
}

// Resolves once the server has observed the client abort the matching request.
export async function serverObservedAbort(remote, matches) {
  const { response } = await serverRequest(remote, matches);
  if (!response.closed) await once(response, 'close');
}

// A real MCP server whose first close (idle eviction, shutdown) is observable.
export function closeObservedMcp() {
  const closed = Promise.withResolvers();
  return {
    closed: closed.promise,
    createMcp: (app, options) => {
      const mcp = createMcpServer(app, options);
      return {
        connect: transport => mcp.connect(transport),
        close: () => {
          closed.resolve();
          return mcp.close();
        }
      };
    }
  };
}

export async function startRemote(options = {}) {
  return createRemoteMcpHttpServer({
    app: {},
    host: '127.0.0.1',
    port: 0,
    bearerToken: TOKEN,
    personalProjectId: 'project-1',
    personalSpaceId: 'space-1',
    sourceApplication: 'claude',
    shutdownGraceMs: 50,
    ...options
  });
}

export function rawJsonRequest(url, body, headers = {}) {
  const text = JSON.stringify(body);
  const { request, response } = jsonRequest(url, {
    ...headers,
    'content-length': Buffer.byteLength(text)
  });
  request.end(text);
  return response;
}

// Opens a POST whose body the caller writes, and parses its JSON response.
export function jsonRequest(url, headers) {
  let request;
  const response = new Promise((resolve, reject) => {
    request = httpRequest(url, { method: 'POST', headers }, (incoming) => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: incoming.statusCode,
          body: text ? JSON.parse(text) : null
        });
      });
    });
    request.on('error', reject);
  });
  return { request, response };
}
