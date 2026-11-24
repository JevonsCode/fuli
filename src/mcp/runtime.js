import { dirname } from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createWorkerTaskContext } from '../graphiti/worker-task-context.js';
import { createRoundtableTaskContext } from '../agent-roundtable/task-context.js';
import { openLocalMcpCore } from './local-mcp-core.js';
import { nativeMcpRequestContextResolver } from '../agents/native-mcp-context.js';
import { FULI_VERSION } from '../package-metadata.js';
import { diagnosticEventLog } from '../diagnostics/event-log.js';
import { GraphRuntimeConfigurationError } from '../graphiti/runtime-config.js';
import { SOURCE_APPLICATIONS } from '../agents/source-applications.js';
import { registerMcpProcess } from './process-registry.js';
import { MCP_SESSION_STARTED_ENV } from './stdio-relay.js';
import { superviseConsole } from '../local-runtime/console-autostart.js';
import { ownIssuer } from '../runner/task-issuer.js';

export async function runStdio(options) {
  const started = Date.now();
  try { return await startStdio(options); }
  catch (error) {
    if (options.runtimeConfigPath) {
      const source = SOURCE_APPLICATIONS.includes(options.sourceApplication) ? options.sourceApplication : 'other';
      const code = error instanceof GraphRuntimeConfigurationError ? 'mcp_runtime_config_invalid'
        : ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code) ? error.code : 'mcp_start_failed';
      diagnosticEventLog(dirname(options.runtimeConfigPath)).record({ component: 'mcp', operation: `start.${source}`,
        outcome: 'failed', code, durationMs: Date.now() - started });
    }
    throw error;
  }
}

async function startStdio({ runtimeConfigPath, sourceApplication, toolNames = null, toolProfile = 'full', worker = null }) {
  const { server, closeApplication } = openLocalMcpCore({ runtimeConfigPath, options: (application) => ({
    sourceApplication,
    nativeRequestContext: nativeMcpRequestContextResolver(sourceApplication),
    toolNames,
    toolProfile,
    flaMenu: true,
    // A task token a computer following this one gave out names this FULI (task-issuer.js).
    taskIssuer: runtimeConfigPath ? ownIssuer(dirname(runtimeConfigPath)) : null,
    onSession: sessionId => registration?.recordSession(sessionId),
    workerTaskContext: worker !== null ? createWorkerTaskContext(application, worker)
      : process.env.FULI_ROUNDTABLE_DELEGATION
        ? createRoundtableTaskContext(application, { token: process.env.FULI_ROUNDTABLE_DELEGATION }) : null
  }) });
  const transport = new StdioServerTransport();
  const signalHandlers = new Map();
  // Lets a later hook see that this client still runs this version after an
  // update, and the doctor offer to open the sessions this server answered.
  const registration = worker === null ? registerMcpProcess(runtimeConfigPath, { sourceApplication, version: FULI_VERSION, sessionStartedAt: process.env[MCP_SESSION_STARTED_ENV] }) : null;
  // A client session keeps the installed console running (rec#94); a worker's
  // process belongs to a session that already does.
  const stopSupervising = worker === null && runtimeConfigPath
    ? superviseConsole({ dataDir: dirname(runtimeConfigPath) }) : () => {};
  const close = createCloseOnce({
    closeServer: () => server.close(),
    closeApplication,
    afterClose: () => { stopSupervising(); registration?.unregister(); removeHandlers(signalHandlers); }
  });
  const quietClose = createQuietCloser(close, () => { process.exitCode = 1; });

  server.server.onclose = quietClose;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = quietClose;
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  process.stdin.once('end', quietClose);

  try {
    await server.connect(transport);
  } catch (error) {
    await close();
    throw error;
  }
}

export function createCloseOnce({ closeServer, closeApplication, afterClose = () => {} }) {
  let closing;
  return () => {
    if (!closing) {
      closing = Promise.resolve().then(async () => {
        try {
          await closeServer();
        } finally {
          try {
            await closeApplication();
          } finally {
            afterClose();
          }
        }
      });
    }
    return closing;
  };
}

function createQuietCloser(close, onFailure = () => {}) {
  return () => {
    close().catch(onFailure);
  };
}

function removeHandlers(signalHandlers) {
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}
