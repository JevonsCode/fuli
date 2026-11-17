import { describeWorkspace } from '../graphiti/workspace-facts.js';
import { REPLAY_WAIT_MS, RUNNER_PATHS } from './protocol.js';

// Delivers a runner's outbox (docs/runner.md) oldest first, one entry at a
// time, while the host answers. An entry the host applied, or had applied
// before (the host remembers every id of this runner), is delivered; one the
// host refused for good is kept as failed with the reason; anything else stops
// the round and the entry waits for the next: the host away, busy, failing,
// still applying that id (409), or not answering within REPLAY_WAIT_MS (it may
// still apply it; the next delivery under the same id is told so). Several MCP
// processes may deliver at once: only the oldest entry is ever held, by one of
// them (runner-store.js claimNext). A host that no longer knows this runner
// ends the pairing here, and the outbox with it.
const ROUND_LIMIT = 50;

export async function deliverOutbox({ store, connection, describe = describeWorkspace, limit = ROUND_LIMIT }) {
  let delivered = 0;
  let refused = 0;
  for (let index = 0; index < limit; index += 1) {
    const entry = store.claimNext();
    if (!entry) break;
    if (entry.offlineProjectPath) {
      let facts;
      try { facts = await describe(entry.offlineProjectPath); } catch {
        store.failed(entry.id, 'folder_gone');
        refused += 1;
        continue;
      }
      const described = await connection.postJson(RUNNER_PATHS.workspace, { facts });
      if (described.revoked) break;
      if (waitAgain(described)) {
        store.release(entry.id, 'host_unreachable');
        break;
      }
    }
    const answer = await connection.postJson(RUNNER_PATHS.replay, { id: entry.id, tool: entry.tool, input: entry.input,
      sourceApplication: entry.sourceApplication, sessionId: entry.sessionId,
      offlineTask: entry.offlineProjectPath ? { projectPath: entry.offlineProjectPath } : null }, { timeoutMs: REPLAY_WAIT_MS });
    if (answer.revoked) break;
    if (waitAgain(answer)) {
      store.release(entry.id, answer.reachable ? (answer.body?.error ?? `http_${answer.status}`)
        : answer.timedOut ? 'host_timeout' : 'host_unreachable');
      break;
    }
    if (answer.status === 200) {
      store.delivered(entry.id);
      delivered += 1;
    } else {
      store.failed(entry.id, answer.body?.error ?? `http_${answer.status}`);
      refused += 1;
    }
  }
  // refused: entries this round the host refused for good; failed: the latest refused entries, kept.
  return { delivered, refused, ...store.outbox() };
}

// The host away, busy, still applying the entry, or failing on its side: the entry is not the problem.
function waitAgain(answer) {
  return !answer.reachable || answer.status >= 500 || [403, 409, 429].includes(answer.status);
}
