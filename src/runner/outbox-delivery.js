import { describeWorkspace } from '../graphiti/workspace-facts.js';
import { RUNNER_PATHS } from './protocol.js';

// Delivers a runner's outbox (docs/runner.md) in order, one entry at a time,
// while the host answers. An entry the host applied, or had applied before
// (the host remembers every id), is delivered; one the host refused for good
// is kept as failed with the reason; anything else stops the round and the
// entry waits for the next. Several MCP processes may deliver at once: each
// entry is held by one of them (runner-store.js claimNext).
const ROUND_LIMIT = 50;

export async function deliverOutbox({ store, connection, describe = describeWorkspace, limit = ROUND_LIMIT }) {
  let delivered = 0;
  let failed = 0;
  for (let index = 0; index < limit; index += 1) {
    const entry = store.claimNext();
    if (!entry) break;
    if (entry.offlineProjectPath) {
      let facts;
      try { facts = await describe(entry.offlineProjectPath); } catch {
        store.failed(entry.id, 'folder_gone');
        failed += 1;
        continue;
      }
      const described = await connection.postJson(RUNNER_PATHS.workspace, { facts });
      if (waitAgain(described)) {
        store.release(entry.id, 'host_unreachable');
        break;
      }
    }
    const answer = await connection.postJson(RUNNER_PATHS.replay, { id: entry.id, tool: entry.tool, input: entry.input,
      sourceApplication: entry.sourceApplication, sessionId: entry.sessionId,
      offlineTask: entry.offlineProjectPath ? { projectPath: entry.offlineProjectPath } : null });
    if (waitAgain(answer)) {
      store.release(entry.id, answer.reachable ? (answer.body?.error ?? `http_${answer.status}`) : 'host_unreachable');
      break;
    }
    if (answer.status === 200) {
      store.delivered(entry.id);
      delivered += 1;
    } else {
      store.failed(entry.id, answer.body?.error ?? `http_${answer.status}`);
      failed += 1;
    }
  }
  return { delivered, failed, ...store.outbox() };
}

// The host away, busy, or failing on its side: the entry is not the problem.
function waitAgain(answer) {
  return !answer.reachable || answer.status >= 500 || answer.status === 429 || answer.status === 403;
}
