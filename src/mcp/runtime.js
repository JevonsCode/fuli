import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  bindRuntimeLeaseAgentTools,
  createRuntimeLeaseClient
} from '../adaptive-runtime/lease-client.js';
import { openFederatedGraphApplication } from '../graphiti/federated-application.js';
import { createMcpServer } from './create-mcp-server.js';

export async function runStdio({ runtimeConfigPath, sourceApplication }) {
  const app = openFederatedGraphApplication({ runtimeConfigPath });
  const leaseClient = createRuntimeLeaseClient({ runtimeConfigPath });
  bindRuntimeLeaseAgentTools(app, leaseClient);
  const server = createServerOrClose(app, createMcpServer, {
    sourceApplication,
    withRuntimeLease: leaseClient.withGraphLease
  });
  const transport = new StdioServerTransport();
  const signalHandlers = new Map();
  const close = createCloseOnce({
    closeServer: () => server.close(),
    closeApplication: async () => {
      await leaseClient.close();
      return app.close();
    },
    afterClose: () => removeHandlers(signalHandlers)
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
