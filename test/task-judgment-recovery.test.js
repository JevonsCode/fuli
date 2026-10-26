import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { selectedTaskEntryPreferences } from '../src/graphiti/task-entry-preferences.js';
import { readTaskPreferences } from '../src/graphiti/task-preference-reader.js';
import { createJudgmentService } from '../src/judgment/service.js';
import { JudgmentStore } from '../src/judgment/store.js';
import { createKnowledgeRecoveryGate } from '../src/knowledge-hard-delete/recovery-gate.js';

const SPACE = 'synthetic-entry-space';

test('a fresh task entry waits for recovery verification before reading its disk judgment policy', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-entry-recovery-'));
  const gate = createKnowledgeRecoveryGate({ dataDir, readWatermark: async input => {
    assert.deepEqual(input, { personalSpaceId: SPACE });
    return { count: 0, latest_deleted_at: null };
  } });
  const app = { config: { personal: { spaceId: SPACE } }, personal: {
    collaborationPreferences: async () => ({ personal_space_id: SPACE, personal_project_id: null,
      effective_preferences: [], global_preferences: [], project_preferences: [], agent_preferences: [] })
  } };
  app.judgment = createJudgmentService({ app, prepareStore: spaceId => gate.refresh(spaceId),
    openStore: () => new JudgmentStore(join(dataDir, 'judgment.sqlite'), { recoveryGate: gate }) });
  try {
    const entry = await selectedTaskEntryPreferences(app, { personalProjectId: null, status: 'unmatched' },
      { sourceApplication: 'codex', sessionId: 'synthetic-entry', taskPrompt: null }, null, async () => {},
      { includeManagement: false, includeMessages: false });
    assert.equal(entry.judgment_context.policy.mode, 'manual');
    assert.equal(entry.judgment_context.policy.personalProjectId, null);
    assert.equal(typeof entry.judgment_context.then, 'undefined');
  } finally {
    app.judgment.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});


test('fresh preference recovery waits for its disk policy and still refuses unavailable graph proof', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-reader-recovery-'));
  let online = true;
  const gate = createKnowledgeRecoveryGate({ dataDir, maxAgeMs: 60_000, readWatermark: async input => {
    assert.deepEqual(input, { personalSpaceId: SPACE });
    if (!online) throw new Error('Synthetic provider unavailable');
    return { count: 0, latest_deleted_at: null };
  } });
  const task = { token: 'fuli-task-synthetic-recovery', sessionId: 'synthetic-reader', sourceApplication: 'codex',
    personalProjectId: null, projectAgentId: 'synthetic-agent', checkpoint: null,
    preferenceScope: { version: 1, work_kind: 'implementation', workflow: 'release' },
    agentAssignment: { selection_reason: 'explicit_agent', match_basis: ['synthetic'] } };
  const app = { config: { personal: { spaceId: SPACE } }, personal: {
    getProjectAgent: async () => ({ agent_id: task.projectAgentId,
      profile: { name: 'Synthetic Agent', status: 'active', responsibility: 'Synthetic fixture' } })
  }, taskContextRegistry: { preferences: async () => ({ task, preferences: {
    personal_space_id: SPACE, personal_project_id: null, project_agent_id: task.projectAgentId,
    effective_preferences: [], global_preferences: [], project_preferences: [], agent_preferences: [],
    conflicts: [], queued_conflicts: [], truncated: false, task_scope_filtered: true,
    source_windows: { candidates_truncated: false, project_ancestors_truncated: false, queued_conflicts_truncated: false }
  } }) } };
  app.judgment = createJudgmentService({ app, prepareStore: spaceId => gate.refresh(spaceId),
    openStore: () => new JudgmentStore(join(dataDir, 'judgment.sqlite'), { recoveryGate: gate }) });
  const input = { taskContextToken: task.token, sourceApplication: 'codex',
    sourceSessionId: task.sessionId, sourceSessionVerified: true };
  try {
    const recovered = await readTaskPreferences(app, input);
    assert.equal(recovered.judgment_context.policy.mode, 'manual');
    assert.equal(typeof recovered.judgment_context.then, 'undefined');
    online = false;
    await gate.refresh(SPACE, { force: true });
    await assert.rejects(readTaskPreferences(app, input), { code: 'knowledge_recovery_pending', status: 503 });
  } finally {
    app.judgment.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
