import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { nativeMcpRequestContextResolver } from '../agents/native-mcp-context.js';
import { openLocalMcpCore } from '../mcp/local-mcp-core.js';
import { FULI_VERSION } from '../package-metadata.js';
import { CALL_TIMEOUT_MS } from './protocol.js';
import { ownIssuer } from './task-issuer.js';

// The half of a follower's MCP server that answers the scopes this computer
// owns (docs/runner-roles-design.md §4): the same MCP server a client's stdio
// entry opens on any FULI (mcp/local-mcp-core.js), on this computer's own
// graph, reached in this process through an in-memory MCP client. So an answer
// here has the shape, budgets and token checks a host's answer has. Its
// session is the client session the follower's MCP process serves, the same
// one it names to the host: a session belongs to the computer the call is made on.
//
// runner-mcp.js loads this module only for the first call of a scope this
// computer owns; a follower that owns none, and a computer that follows no
// host, never do. globalWrites: the port that sends a checkpoint's writes to
// global to the host (global-writes-outbox.js). open: the MCP core, replaced in tests.
export function createLocalScopeServer({ dataDir, sourceApplication, toolProfile, sessionId, globalWrites,
  open = openLocalMcpCore }) {
  let opening = null;

  function opened() {
    opening ??= (async () => {
      const core = open({ runtimeConfigPath: join(dataDir, 'graph-runtime.json'), globalWrites, options: () => ({
        sourceApplication, hostSessionId: sessionId, toolProfile, flaMenu: true,
        nativeRequestContext: nativeMcpRequestContextResolver(sourceApplication),
        // A token this half gave out names this computer; the server takes it back as its own.
        taskIssuer: ownIssuer(dataDir)
      }) });
      const client = new Client({ name: 'fuli-runner-local', version: FULI_VERSION });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      try {
        await core.server.connect(serverSide);
        await client.connect(clientSide);
      } catch (error) {
        await core.closeApplication().catch(() => {});
        throw error;
      }
      return { ...core, client };
    })();
    // One that could not open (its runtime not configured yet) is opened afresh by the next call.
    opening.catch(() => { opening = null; });
    return opening;
  }

  return {
    async call(name, args) {
      const { client } = await opened();
      return client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true });
    },
    // This computer's application, for what the follower reads of its own graph besides a call (owner-recruitments.js).
    async application() {
      return (await opened()).app;
    },
    async close() {
      if (!opening) return;
      const core = await opening.catch(() => null);
      if (!core) return;
      await core.client.close().catch(() => {});
      await core.server.close().catch(() => {});
      await core.closeApplication();
    }
  };
}
