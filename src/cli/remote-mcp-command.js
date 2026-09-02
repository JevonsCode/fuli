import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync
} from 'node:fs';
import { resolve } from 'node:path';

import {
  bindRuntimeLeaseAgentTools,
  createRuntimeLeaseClient
} from '../adaptive-runtime/lease-client.js';
import { openFederatedGraphApplication } from '../graphiti/federated-application.js';
import { resolveGraphRuntimeOptions } from '../graphiti/runtime-config.js';
import { createRemoteMcpHttpServer } from '../mcp/remote-http-server.js';
import { normalizeMcpSourceApplication } from '../mcp/session-id.js';

const DEFAULT_REMOTE_MCP_PORT = 2728;
const DEFAULT_REMOTE_MCP_MAX_SESSIONS = 8;
const DEFAULT_REMOTE_MCP_SESSION_IDLE_TTL_SECONDS = 15 * 60;
const REMOTE_MCP_OPTIONS = new Set([
  '--personal-project-id', '--bearer-token-file', '--data-dir', '--host', '--port',
  '--source-application', '--allowed-origin', '--allowed-host', '--max-sessions',
  '--session-idle-ttl-seconds'
]);

export function parseRemoteMcpOptions(args) {
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!REMOTE_MCP_OPTIONS.has(flag)) {
      throw new TypeError(`Unknown remote MCP option: ${flag}`);
    }
    const value = args[index + 1];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new TypeError(`Missing value for ${flag}`);
    }
  }
  const personalProjectId = requiredOption(args, '--personal-project-id');
  const bearerTokenFile = requiredOption(args, '--bearer-token-file');
  const dataDir = optionalOption(args, '--data-dir');
  const host = optionalOption(args, '--host') ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new TypeError('Remote MCP must bind to a loopback host behind an authenticated HTTPS proxy');
  }
  const port = numberOption(args, '--port', DEFAULT_REMOTE_MCP_PORT);
  const sourceApplication = normalizeMcpSourceApplication(
    optionalOption(args, '--source-application') ?? 'claude'
  );
  const allowedOrigin = optionalOption(args, '--allowed-origin');
  const allowedHost = optionalOption(args, '--allowed-host');
  const maxSessions = boundedIntegerOption(
    args, '--max-sessions', DEFAULT_REMOTE_MCP_MAX_SESSIONS, 1, 64
  );
  const sessionIdleTtlSeconds = boundedIntegerOption(
    args,
    '--session-idle-ttl-seconds',
    DEFAULT_REMOTE_MCP_SESSION_IDLE_TTL_SECONDS,
    10,
    24 * 60 * 60
  );
  return {
    personalProjectId,
    bearerTokenFile,
    dataDir,
    port,
    host,
    sourceApplication,
    allowedOrigin,
    allowedHost,
    maxSessions,
    sessionIdleTtlSeconds
  };
}

export async function runRemoteMcpCommand(args, dependencies = {}) {
  const options = parseRemoteMcpOptions(args);
  const env = dependencies.env ?? process.env;
  const runtimeConfigPath = resolveGraphRuntimeOptions([], env, {
    setupPaths: { dataDir: options.dataDir ?? undefined }
  }).runtimeConfigPath;
  const readToken = dependencies.readBearerToken ?? readBearerToken;
  const bearerToken = readToken(options.bearerTokenFile);
  const openApplication = dependencies.openApplication ?? openFederatedGraphApplication;
  const createLeaseClient = dependencies.createLeaseClient ?? createRuntimeLeaseClient;
  const bindLeaseTools = dependencies.bindRuntimeLeaseAgentTools
    ?? bindRuntimeLeaseAgentTools;
  let app;
  let leaseClient;
  let remote;
  try {
    app = openApplication({ runtimeConfigPath });
    leaseClient = createLeaseClient({ runtimeConfigPath });
    bindLeaseTools(app, leaseClient);
    await leaseClient.withGraphLease(
      'remote-mcp-project-preflight',
      () => assertPersonalProjectExists(
        app,
        app.config.personal.spaceId,
        options.personalProjectId
      )
    );
    remote = await (dependencies.createRemoteServer ?? createRemoteMcpHttpServer)({
      app,
      bearerToken,
      personalProjectId: options.personalProjectId,
      personalSpaceId: app.config.personal.spaceId,
      sourceApplication: options.sourceApplication,
      host: options.host,
      port: options.port,
      allowedOrigins: options.allowedOrigin ? [options.allowedOrigin] : [],
      allowedHosts: options.allowedHost ? [options.allowedHost] : [],
      maxSessions: options.maxSessions,
      sessionIdleTtlMs: options.sessionIdleTtlSeconds * 1000,
      withRuntimeLease: (owner, operation) => leaseClient.withGraphLease(owner, operation)
    });
  } catch (error) {
    await Promise.allSettled([
      Promise.resolve().then(() => leaseClient?.close?.()),
      Promise.resolve().then(() => app?.close?.())
    ]);
    throw error;
  }

  const signalTarget = dependencies.signalTarget ?? process;
  const writeError = dependencies.writeError ?? ((value) => process.stderr.write(value));
  const reportError = dependencies.reportError ?? ((error) => {
    writeError(`Fuli remote MCP shutdown failed: ${describeError(error)}\n`);
  });
  const setExitCode = dependencies.setExitCode ?? ((code) => { process.exitCode = code; });
  const handlers = new Map();
  let closing;
  const close = () => {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      const failures = [];
      for (const resource of [remote, leaseClient, app]) {
        try {
          await resource.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Fuli remote MCP shutdown failed');
      }
    }).finally(() => {
      for (const [signal, handler] of handlers) signalTarget.off(signal, handler);
    });
    return closing;
  };
  const write = dependencies.write ?? ((value) => process.stdout.write(`${value}\n`));
  try {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        void close().catch((error) => {
          setExitCode(1);
          reportError(error);
        });
      };
      handlers.set(signal, handler);
      signalTarget.once(signal, handler);
    }
    write([
      `Fuli remote MCP listening on ${remote.url}/mcp`,
      `Bound project: ${options.personalProjectId}`,
      'This listener is loopback-only. Publish it only through an authenticated HTTPS OAuth proxy; never expose the local Provider or Neo4j ports.'
    ].join('\n'));
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      const cleanupFailures = cleanupError instanceof AggregateError
        ? cleanupError.errors
        : [cleanupError];
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Fuli remote MCP startup finalization failed'
      );
    }
    throw error;
  }
  return { status: 'running', url: `${remote.url}/mcp`, close, server: remote.server };
}

function describeError(error) {
  if (error instanceof AggregateError) {
    return error.errors.map(describeError).join('; ');
  }
  return error?.message ?? String(error);
}

async function assertPersonalProjectExists(app, personalSpaceId, personalProjectId) {
  const projects = await app.listPersonalProjects({ personalSpaceId });
  if (!Array.isArray(projects) || !projects.some(project => [
    project?.project_id,
    project?.projectId,
    project?.personal_project_id,
    project?.personalProjectId
  ].includes(personalProjectId))) {
    throw new TypeError(
      `Remote MCP project ${personalProjectId} does not exist in the configured personal space`
    );
  }
}

export function readBearerToken(path, fileSystem = {}) {
  const open = fileSystem.openSync ?? openSync;
  const fstat = fileSystem.fstatSync ?? fstatSync;
  const readFile = fileSystem.readFileSync ?? readFileSync;
  const close = fileSystem.closeSync ?? closeSync;
  const constants = fileSystem.constants ?? fsConstants;
  const absolute = resolve(path);
  let descriptor;
  try {
    descriptor = open(
      absolute,
      constants.O_RDONLY
        | (constants.O_NOFOLLOW ?? 0)
        | (constants.O_NONBLOCK ?? 0)
    );
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') {
      throw new TypeError('Remote MCP bearer token path must not be a symbolic link');
    }
    throw error;
  }
  try {
    const metadata = fstat(descriptor);
    if (!metadata.isFile()) throw new TypeError('Remote MCP bearer token path must be a regular file');
    if (metadata.size > 4096) {
      throw new TypeError('Remote MCP bearer token file must not exceed 4096 bytes');
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
      throw new TypeError('Remote MCP bearer token file must be readable only by its owner (chmod 600)');
    }
    const token = readFile(descriptor, 'utf8').trim();
    if (!/^[\x21-\x7E]{24,512}$/.test(token)) {
      throw new TypeError(
        'Remote MCP bearer token must contain 24 to 512 visible ASCII characters without spaces'
      );
    }
    return token;
  } finally {
    close(descriptor);
  }
}

function requiredOption(args, flag) {
  const value = optionalOption(args, flag);
  if (!value) throw new TypeError(`Missing ${flag}`);
  return value;
}

function optionalOption(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  if (args.indexOf(flag, index + 1) !== -1) throw new TypeError(`Duplicate ${flag}`);
  const value = args[index + 1];
  if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
    throw new TypeError(`Missing value for ${flag}`);
  }
  return value;
}

function numberOption(args, flag, fallback) {
  return boundedIntegerOption(args, flag, fallback, 0, 65_535);
}

function boundedIntegerOption(args, flag, fallback, minimum, maximum) {
  const value = optionalOption(args, flag);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new TypeError(`${flag} must be an integer from ${minimum} to ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${flag} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}
