import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  bindRuntimeLeaseAgentTools,
  createRuntimeLeaseClient
} from '../adaptive-runtime/lease-client.js';
import { openFederatedGraphApplication } from '../graphiti/federated-application.js';
import { createWorkerTaskContext } from '../graphiti/worker-task-context.js';
import { createRoundtableTaskContext } from '../agent-roundtable/task-context.js';
import { createMcpServer } from './create-mcp-server.js';
import { nativeMcpRequestContextResolver } from '../agents/native-mcp-context.js';
import { FULI_VERSION } from '../package-metadata.js';
import { registerMcpProcess } from './process-registry.js';

export async function runStdio({ runtimeConfigPath, sourceApplication, toolNames = null, toolProfile = 'full', worker = null }) {
  const app = openFederatedGraphApplication({ runtimeConfigPath });
  const leaseClient = createRuntimeLeaseClient({ runtimeConfigPath });
  bindRuntimeLeaseAgentTools(app, leaseClient);
  const server = createServerOrClose(app, (application, options) => createMcpServer(application, {
    ...options, workerTaskContext: worker !== null ? createWorkerTaskContext(application, worker)
      : process.env.FULI_ROUNDTABLE_DELEGATION
        ? createRoundtableTaskContext(application, { token: process.env.FULI_ROUNDTABLE_DELEGATION }) : null
  }), {
    sourceApplication,
    nativeRequestContext: nativeMcpRequestContextResolver(sourceApplication),
    toolNames,
    toolProfile,
    withRuntimeLease: leaseClient.withGraphLease,
    onSession: sessionId => registration?.recordSession(sessionId)
  });
  const transport = new StdioServerTransport();
  const signalHandlers = new Map();
  // Lets a later hook see that this client still runs this version after an
  // update, and the doctor offer to open the sessions this server answered.
  const registration = worker === null ? registerMcpProcess(runtimeConfigPath, { sourceApplication, version: FULI_VERSION }) : null;
  const close = createCloseOnce({
    closeServer: () => server.close(),
    closeApplication: async () => {
      await leaseClient.close();
      return app.close();
    },
    afterClose: () => { registration?.unregister(); removeHandlers(signalHandlers); }
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

export function createServerOrClose(app, factory = createMcpServer, options) {
  try {
    return factory(app, options);
  } catch (error) {
    void app.close();
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

export function createQuietCloser(close, onFailure = () => {}) {
  return () => {
    close().catch(onFailure);
  };
}

function removeHandlers(signalHandlers) {
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}
