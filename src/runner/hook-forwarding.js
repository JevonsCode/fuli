import { join } from 'node:path';

import { loadDeviceIdentity } from '../../packages/roundtable/src/peer/device-identity.js';
import { describeWorkspace } from '../graphiti/workspace-facts.js';
import { createHostConnection } from './host-connection.js';
import { RUNNER_PATHS } from './protocol.js';
import { RUNNER_FILE, RunnerStore } from './runner-store.js';

// A prompt hook on a runner (docs/runner.md), forwarded to the host: the host
// enters the task as a local client's prompt hook would, for the client's own
// session, and answers what the hook prints. A client names its session only to
// its hooks (Codex gives MCP servers no thread ID), so this is how a runner's
// client gets a task token. The folder goes as its facts; the transcript stays
// here. null when the host cannot take it: the hook then says how to enter the
// task through FULI's MCP tools instead.
const MARGIN_MS = 1500;

export async function forwardHookToHost({ dataDir, client, event, env, stdin, deadlineAt,
  describe = describeWorkspace, now = Date.now }) {
  let payload;
  try { payload = JSON.parse(Buffer.concat(stdin).toString('utf8').replace(/^﻿/, '')); } catch { return null; }
  if (!payload || typeof payload !== 'object' || typeof payload.cwd !== 'string') return null;
  let facts;
  try { facts = await describe(payload.cwd); } catch { return null; }
  const store = new RunnerStore(join(dataDir, RUNNER_FILE));
  let connection = null;
  try {
    if (!store.host()) return null;
    connection = createHostConnection({ store, identity: await loadDeviceIdentity(join(dataDir, 'peer')) });
    const { transcript_path: _local, ...sent } = payload;
    const answer = await connection.postJson(RUNNER_PATHS.hook, { client, event, env, payload: sent, facts },
      { timeoutMs: Math.max(1000, deadlineAt - now() - MARGIN_MS) });
    return answer.reachable && answer.status === 200 && typeof answer.body?.stdout === 'string' ? answer.body : null;
  } finally {
    connection?.close();
    store.close();
  }
}
