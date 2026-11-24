import {
  bindRuntimeLeaseAgentTools,
  createRuntimeLeaseClient
} from '../adaptive-runtime/lease-client.js';
import { openFederatedGraphApplication } from '../graphiti/federated-application.js';
import { createMcpServer } from './create-mcp-server.js';

// What a FULI MCP server needs on the computer whose graph answers it: the
// application on this data directory's graph, the runtime lease that keeps
// that graph up while a call runs, and the MCP server over both. A client's
// stdio entry (runtime.js) and a follower's local half for the scopes it owns
// (runner/local-scope-server.js) open it the same way, so both answer as one
// FULI answers.
//
// options(app): the MCP server's options besides its lease, given the
// application (a worker's task context is made from it).
// globalWrites: where a checkpoint's writes to global go (graphiti/global-writes-port.js);
// unset, this computer's own graph.
// Answers { app, server, closeApplication }; closeApplication ends the lease, then the application.
export function openLocalMcpCore({ runtimeConfigPath, globalWrites, options = () => ({}), createServer = createMcpServer }) {
  const app = openFederatedGraphApplication({ runtimeConfigPath, ...(globalWrites ? { globalWrites } : {}) });
  const leaseClient = createRuntimeLeaseClient({ runtimeConfigPath });
  bindRuntimeLeaseAgentTools(app, leaseClient);
  let server;
  try {
    server = createServer(app, { ...options(app), withRuntimeLease: leaseClient.withGraphLease });
  } catch (error) {
    void app.close();
    throw error;
  }
  return { app, server, closeApplication: async () => {
    await leaseClient.close();
    return app.close();
  } };
}
