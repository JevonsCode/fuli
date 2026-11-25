import { movedTask } from './moved-task.js';
import { join } from 'node:path';

import { describeWorkspace } from '../graphiti/workspace-facts.js';
import { failingReason, holdReason, hostTakesGlobalWrites, requeueHeldWrites, settleGlobalWrites } from './global-writes-outbox.js';
import { GLOBAL_WRITES_ENTRY, REPLAY_WAIT_MS, RUNNER_PATHS } from './protocol.js';

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
//
// A follower's writes to global (global-writes-outbox.js) go only to a host
// that applies them; for another the entry is held, and queued again once the
// host answers on another version. The host answers them op by op, and each op
// is kept as it answered (settleGlobalWrites): one refused never makes the
// others failed. One the host keeps failing on (MAX_HOST_FAILURES answers of
// 5xx in a row) is held too, so it does not hold the outbox for ever, and is
// queued again at the next new hello or another version of the host
// (requeueHeldWrites): never dropped, never tried every round. onWritesApplied:
// the host applied some of them, so the copy of global here is out of date.
const ROUND_LIMIT = 50;
const MAX_HOST_FAILURES = 10;
const HOST_FAILED = 'host_failed:';
// The connections (one per hello) whose held entries were already given their round again.
const greeted = new WeakSet();

export async function deliverOutbox({ store, connection, dataDir, describe = describeWorkspace, limit = ROUND_LIMIT,
  recruitmentState = async input => {
    const { localGraphRecruitmentState } = await import('./local-graph-projects.js');
    return localGraphRecruitmentState(join(dataDir, 'graph-runtime.json'), input);
  }, onWritesApplied = () => {} }) {
  let delivered = 0;
  let refused = 0;
  const reached = connection.current;
  if (reached) {
    requeueHeldWrites(store, reached, { newHello: !greeted.has(reached) });
    greeted.add(reached);
  }
  for (let index = 0; index < limit; index += 1) {
    const entry = store.claimNext();
    if (!entry) break;
    if (movedTask(dataDir, entry.input?.taskContextToken)) {
      store.failed(entry.id, 'project_task_moved');
      refused++;
      continue;
    }
    const writes = entry.tool === GLOBAL_WRITES_ENTRY;
    if (writes) {
      const host = await connection.connect();
      if (!host) {
        store.release(entry.id, 'host_unreachable');
        break;
      }
      if (!hostTakesGlobalWrites(host)) {
        store.failed(entry.id, holdReason(host.version));
        continue;
      }
    }
    if (writes && entry.id.startsWith('recruit:')) {
      // Dedicated owner hires contain one op, including entries retained for retry.
      const [op] = entry.input?.ops ?? [];
      let state;
      try {
        if (entry.input.ops.length === 1 && op?.kind === 'recruit') state = await recruitmentState(op.input);
      } catch { /* the local Provider is temporarily unavailable */ }
      if (state === 'fulfilled') {
        store.settleWrites(entry.id, { input: { ...entry.input,
          outcomes: [{ kind: 'recruit', outcome: 'applied', code: 'already_fulfilled' }] } });
        continue;
      }
      if (state === 'withdrawn') {
        store.failed(entry.id, 'recruitment_withdrawn');
        continue;
      }
      if (state !== 'waiting') {
        store.release(entry.id, 'local_recruitment_unknown');
        break;
      }
    }
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
      const failures = writes && answer.reachable && answer.status >= 500 ? hostFailures(entry.lastError) + 1 : 0;
      if (failures >= MAX_HOST_FAILURES) {
        store.failed(entry.id, failingReason(connection.current?.version));
        continue;
      }
      store.release(entry.id, failures ? `${HOST_FAILED}${failures}`
        : answer.reachable ? (answer.body?.error ?? `http_${answer.status}`)
          : answer.timedOut ? 'host_timeout' : 'host_unreachable');
      break;
    }
    if (answer.status === 200) {
      if (!writes) store.delivered(entry.id);
      else if (settleGlobalWrites(store, entry, answer.body, connection.current?.version ?? null)) onWritesApplied();
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

// How many answers of 5xx in a row this entry got, as its last error says.
function hostFailures(lastError) {
  const count = typeof lastError === 'string' && lastError.startsWith(HOST_FAILED)
    ? Number(lastError.slice(HOST_FAILED.length)) : 0;
  return Number.isSafeInteger(count) ? count : 0;
}
