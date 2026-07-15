import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { openLocalApplication } from '../runtime-options.js';
import { createMcpServer } from './create-mcp-server.js';

export { initializeLocalSpaces, openLocalApplication } from '../runtime-options.js';

export async function runStdio({ dbPath, personalSpaceName = '我' }) {
  const app = openLocalApplication({ dbPath, personalSpaceName });
  const server = createServerOrClose(app);
  const transport = new StdioServerTransport();
  const signalHandlers = new Map();
  const close = createCloseOnce({
    closeServer: () => server.close(),
    closeApplication: () => app.close(),
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

export function createServerOrClose(app, factory = createMcpServer) {
  try {
    return factory(app);
  } catch (error) {
    app.close();
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
