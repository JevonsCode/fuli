#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleApiRequest } from './http/api-router.js';
import { mapHttpError } from './http/error-mapping.js';
import { localServerAuthority, rejectRequestOutsidePolicy } from './http/request-policy.js';
import { sendJson } from './http/response.js';
import { serveStatic } from './http/static-handler.js';
import { DEFAULT_FULI_PORT } from './defaults.js';
import { resolveGraphRuntimeOptions } from './graphiti/runtime-config.js';
import { isFetchBlockedPort } from './server/blocked-ports.js';
import {
  discoverLanAddresses,
  lanConsoleUrls,
  lanServerAuthorities
} from './server/lan-access.js';
import { createServerApplication } from './server/application-lifecycle.js';
import { listenServer } from './server/listen.js';
import { resolveSetupPaths } from './setup/paths.js';
import { createSystemService } from './system/system-service.js';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export async function createServer(options = {}) {
  const {
    port = DEFAULT_FULI_PORT,
    app,
    closeApplicationOnShutdown,
    isBlockedPort = isFetchBlockedPort,
    lan = false,
    lanAccessToken = null,
    lanAddresses: configuredLanAddresses = null
  } = options;
  const lanEnabled = lan === true;
  const lanToken = lanEnabled ? requiredLanToken(lanAccessToken) : null;
  const lanAddresses = lanEnabled
    ? [...new Set(configuredLanAddresses ?? discoverLanAddresses())]
    : [];
  if (lanEnabled && lanAddresses.length === 0) {
    throw new Error('No private IPv4 LAN address is available');
  }
  if (Number(port) !== 0 && isBlockedPort(port)) {
    throw new Error(`Port ${port} is blocked for local fetch`);
  }
  const localOptions = app ? {} : resolveServerGraphOptions(options);
  const runtime = createServerApplication({
    app,
    ...localOptions,
    closeApplicationOnShutdown
  });
  const application = runtime.application;
  let externalKnowledge;
  let connectedKnowledge;
  let system = null;
  let resourcesClosing = null;
  function closeResources() {
    resourcesClosing ??= (async () => {
      const failures = [];
      for (const close of [() => system?.close?.(), () => runtime.close()]) {
        try { await close(); } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Server resource shutdown failed');
      }
    })();
    return resourcesClosing;
  }
  async function failStartup(error) {
    try {
      await closeResources();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        `Server startup failed: ${error.message}; resource shutdown also failed`, { cause: error });
    }
    throw error;
  }
  try {
    externalKnowledge = options.externalKnowledge ?? application.externalKnowledge ?? null;
    connectedKnowledge = options.connectedKnowledge ?? application.connectedKnowledge ?? null;
    system = options.system ?? (!app
      ? createSystemService({
          paths: resolveSetupPaths({
            dataDir: dirname(localOptions.runtimeConfigPath),
            packageRoot: PACKAGE_ROOT
          }),
          packageRoot: PACKAGE_ROOT,
          activePort: port,
          activeLan: lanEnabled,
          executorAdapters: options.executorAdapters
        })
      : null);
  } catch (error) {
    // The owned application can already hold local databases before system
    // construction or configuration validation fails, even without a listener.
    await failStartup(error);
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let authority = null;
    let allowedLanAuthorities = [];
    const server = createHttpServer((request, response) => {
      handleRequest({
        request,
        response,
        app: application,
        system,
        externalKnowledge,
        connectedKnowledge,
        authority,
        lanAuthorities: allowedLanAuthorities,
        lanAccessToken: lanToken
      }).catch((error) => {
        if (response.headersSent || response.destroyed) {
          // A post-response lease/storage failure cannot be converted into a second response.
          if (!response.writableEnded) response.destroy();
          console.error('Request failed after its response was committed or disconnected');
          return;
        }
        const mapped = mapHttpError(error);
        sendJson(response, mapped.status, mapped.body);
      });
    });

    try {
      await listenServer(server, port, lanEnabled ? '0.0.0.0' : '127.0.0.1');
    } catch (error) {
      await failStartup(error);
    }
    const address = server.address();
    if (isBlockedPort(address.port)) {
      await new Promise((resolveClose) => server.close(resolveClose));
      if (Number(port) === 0) continue;
      await failStartup(new Error(`Port ${address.port} is blocked for local fetch`));
    }
    authority = localServerAuthority(address);
    allowedLanAuthorities = lanEnabled
      ? lanServerAuthorities(lanAddresses, address.port)
      : [];
    if (!authority) {
      await new Promise((resolveClose) => server.close(resolveClose));
      await failStartup(new Error('Server did not bind to a valid local authority'));
    }

    let closing = null;
    const close = () => {
      closing ??= new Promise((resolve, reject) => {
        server.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING'
          ? reject(error) : resolve());
      }).then(closeResources);
      return closing;
    };
    server.once('close', () => {
      // Legacy callers may close the raw HTTP server; still consume/report asynchronous failures.
      void closeResources().catch((error) => {
        if (!closing) console.error(`Server shutdown failed: ${error.message}`);
      });
    });
    return {
      server,
      close,
      url: `http://${authority}`,
      lanUrls: lanEnabled ? lanConsoleUrls(lanAddresses, address.port) : [],
      app: application
    };
  }

  await failStartup(new Error('Could not find a fetchable local port'));
}

function resolveServerGraphOptions(options) {
  const args = [];
  if (Object.hasOwn(options, 'runtimeConfigPath')) {
    args.push('--runtime-config', options.runtimeConfigPath);
  }
  return resolveGraphRuntimeOptions(args, options.env ?? process.env, {
    setupPaths: { homeDir: options.homeDir, cwd: options.cwd ?? process.cwd() }
  });
}

export { isFetchBlockedPort } from './server/blocked-ports.js';

async function handleRequest({
  request,
  response,
  app,
  system,
  externalKnowledge,
  connectedKnowledge,
  authority,
  lanAuthorities,
  lanAccessToken
}) {
  if (rejectRequestOutsidePolicy({
    request,
    response,
    authority,
    lanAuthorities,
    lanAccessToken
  })) return;
  if (await handleApiRequest({
    request,
    response,
    app,
    system,
    externalKnowledge,
    connectedKnowledge
  })) return;
  serveStatic(new URL(request.url, 'http://127.0.0.1').pathname, response);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runProgram(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function runProgram(args) {
  const runtimeOptions = resolveGraphRuntimeOptions(args, process.env);
  const port = numberOption(args, '--port', DEFAULT_FULI_PORT);
  const lan = args.includes('--lan');
  const { server, close: closeRuntime, url, lanUrls } = await createServer({
    ...runtimeOptions,
    port,
    lan,
    lanAccessToken: lan ? process.env.FULI_LAN_ACCESS_TOKEN : null
  });
  const handlers = new Map();
  const close = () => {
    void closeRuntime().catch((error) => {
      console.error(`Server shutdown failed: ${error.message}`);
      process.exitCode = 1;
    });
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = close;
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  server.once('close', () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  });
  console.log(`复利工作台 running at ${url}`);
  for (const lanUrl of lanUrls) console.log(`复利工作台 LAN at ${lanUrl}`);
}

function requiredLanToken(value) {
  if (typeof value !== 'string' || value.length < 16) {
    throw new TypeError('LAN mode requires a generated access token');
  }
  return value;
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
