#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { handleApiRequest } from './http/api-router.js';
import { mapHttpError } from './http/error-mapping.js';
import { localServerAuthority, rejectDisallowedRequest } from './http/request-policy.js';
import { sendJson } from './http/response.js';
import { serveStatic } from './http/static-handler.js';
import { resolveRuntimeOptions } from './runtime-options.js';
import { createServerApplication } from './server/application-lifecycle.js';
import { listenServer } from './server/listen.js';

const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080
]);

export async function createServer(options = {}) {
  const {
    port = 5173,
    store,
    app,
    closeApplicationOnShutdown,
    isBlockedPort = isFetchBlockedPort
  } = options;
  if (Number(port) !== 0 && isBlockedPort(port)) {
    throw new Error(`Port ${port} is blocked for local fetch`);
  }
  const localOptions = app || store
    ? { dbPath: options.dbPath, personalSpaceName: options.personalSpaceName ?? '我' }
    : resolveServerRuntimeOptions(options);
  const runtime = createServerApplication({
    app,
    store,
    ...localOptions,
    closeApplicationOnShutdown
  });
  const application = runtime.application;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    let authority = null;
    const server = createHttpServer((request, response) => {
      handleRequest({ request, response, app: application, authority }).catch((error) => {
        const mapped = mapHttpError(error);
        sendJson(response, mapped.status, mapped.body);
      });
    });

    try {
      await listenServer(server, port);
    } catch (error) {
      runtime.close();
      throw error;
    }
    const address = server.address();
    if (isBlockedPort(address.port)) {
      await new Promise((resolveClose) => server.close(resolveClose));
      if (Number(port) === 0) continue;
      runtime.close();
      throw new Error(`Port ${address.port} is blocked for local fetch`);
    }
    authority = localServerAuthority(address);
    if (!authority) {
      await new Promise((resolveClose) => server.close(resolveClose));
      runtime.close();
      throw new Error('Server did not bind to a valid local authority');
    }

    server.once('close', runtime.close);
    return { server, url: `http://${authority}`, app: application };
  }

  runtime.close();
  throw new Error('Could not find a fetchable local port');
}

function resolveServerRuntimeOptions(options) {
  const args = [];
  if (Object.hasOwn(options, 'dbPath')) args.push('--db', options.dbPath);
  if (Object.hasOwn(options, 'personalSpaceName')) {
    args.push('--personal-space', options.personalSpaceName);
  }
  return resolveRuntimeOptions(args, options.env ?? process.env, {
    cwd: options.cwd ?? process.cwd(),
    setupPaths: { homeDir: options.homeDir }
  });
}

export function isFetchBlockedPort(port) {
  return FETCH_BLOCKED_PORTS.has(Number(port));
}

async function handleRequest({ request, response, app, authority }) {
  if (rejectDisallowedRequest({ request, response, authority })) return;
  if (await handleApiRequest({ request, response, app })) return;
  serveStatic(new URL(request.url, 'http://127.0.0.1').pathname, response);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runProgram(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function runProgram(args) {
  const runtimeOptions = resolveRuntimeOptions(args, process.env);
  const port = numberOption(args, '--port', 5173);
  const { server, url } = await createServer({ ...runtimeOptions, port });
  const handlers = new Map();
  const close = () => server.close();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = close;
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  server.once('close', () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  });
  console.log(`复利工作台 running at ${url}`);
}

function numberOption(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--') || !Number.isFinite(Number(value))) {
    throw new TypeError(`Missing or invalid value for ${flag}`);
  }
  return Number(value);
}
