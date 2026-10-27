import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { readTaskPreferences } from '../src/graphiti/task-preference-reader.js';
import { loadProjectAgentContinuity } from '../src/graphiti/project-agent-task-entry.js';
import { projectAgentRecord } from '../src/graphiti/project-agent-mapping.js';
import { applyAgentAssignment } from '../src/graphiti/task-agent-assignment.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { entryRules } from '../src/conversations/entry-rules.js';
import { agentCollaborationPreference } from '../src/graphiti/collaboration-preference-projection.js';

const SESSION = '019fc6ed-02a5-7832-8821-68e3b03e7cef';
function fixture(count = 1) {
  const task = { token: 'fuli-task-synthetic-reader', sessionId: SESSION, sourceApplication: 'codex',
    sourceSessionId: 'old-hook-process-provenance', personalProjectId: 'project-a', projectAgentId: 'agent-a',
    preferenceScope: { version: 1, work_kind: 'implementation', workflow: 'release' }, checkpoint: null,
    agentAssignment: { version: 1, selection_reason: 'delegated_member', match_basis: ['This member worker reports to the configured project lead.'],
      requested_agent_id: null, reporting_lead_agent_id: 'lead-a', execution_reason: null, execution_agent_id: null } };
  const items = Array.from({ length: count }, (_, i) => ({ id: `rule-${i}`, item_kind: 'entity',
    instruction: `Synthetic rule ${i}: ` + '规则说明'.repeat(160) + ` END_PREF_${i}`,
    preference_key: `rule-${i}`, preference_scope: 'project', preference_project_id: 'project-a',
    confirmation_status: 'confirmed', preference_qualifiers: { workKind: 'implementation', workflow: 'release' } }));
  const preferences = { personal_space_id: 'space-a', personal_project_id: 'project-a', project_agent_id: 'agent-a',
    effective_preferences: items, global_preferences: [], project_preferences: items, agent_preferences: [],
    conflicts: [], queued_conflicts: [], truncated: false, task_scope_filtered: true,
    source_windows: { candidates_truncated: false, project_ancestors_truncated: false, queued_conflicts_truncated: false } };
  let reads = 0;
  const rawAgent = { agent_id: 'agent-a', profile: { name: 'Synthetic owner', responsibility: 'Owns the sample.',
    initial_preferences: ['ROLE_INITIAL_PREF'], character: { judgment: 'ROLE_JUDGMENT', taste: 'ROLE_TASTE', personality: 'ROLE_PERSONALITY' },
    expectations: 'ROLE_EXPECTATIONS', status: 'active', allowed_clients: ['codex'] } };
  const team = { policy: { team_lead_agent_id: 'lead-a', team_member_agent_ids: ['agent-a'] }, agents: [
    { agent_id: 'lead-a', profile: { name: 'Lead', status: 'active' },
      assignments: [{ personal_project_id: 'project-a', status: 'active' }] },
    { ...rawAgent, assignments: [{ personal_project_id: 'project-a', status: 'active' }] }] };
  const app = { config: { personal: { spaceId: 'space-a' } },
    taskContextRegistry: { preferences: async (token, input) => {
      assert.equal(token, task.token); assert.deepEqual(input, { sourceApplication: 'codex', sessionId: SESSION });
      reads++; return { task: structuredClone(task), preferences: structuredClone(preferences) };
    } }, personal: { getProjectAgent: async () => structuredClone(rawAgent),
      getProjectAgentCoordinationPolicy: async () => structuredClone(team.policy),
      listProjectAgents: async () => structuredClone(team.agents),
      getPersonalProject: async () => ({ profile: { name: 'Sample', purpose: 'PROJECT_PURPOSE', boundaries: ['PROJECT_BOUNDARY'] } }),
      getProjectAgentMemory: () => { throw new Error('Recovery must not read memory'); },
      recordAgentViews: () => { throw new Error('Recovery must not record views'); } },
    judgment: { policy: async () => ({ mode: 'manual', client: 'codex', revision: 1 }) },
    getCollaborationPreferences: () => { throw new Error('Task entry must not run'); },
    beginTaskContext: () => { throw new Error('Task begin must not run'); }
  };
  app.readTaskPreferences = input => readTaskPreferences(app, input);
  return { app, task, preferences, rawAgent, team, reads: () => reads };
}
async function call(f, { env = { CODEX_THREAD_ID: SESSION }, sourceApplication = 'codex', extra = {} } = {}) {
  const server = createMcpServer(f.app, { env, sourceApplication,
    toolNames: ['read_task_preferences'], registerResources: false });
  try {
    return await server.server._requestHandlers.get('tools/call')({ method: 'tools/call',
      params: { name: 'read_task_preferences', arguments: { taskContextToken: f.task.token, ...extra } }
    }, { signal: new AbortController().signal, requestId: 1 });
  } finally { await server.close(); }
}

test('owned reader delivers all long instructions and mandatory guidance in both channels without entry side effects', async () => {
  const f = fixture(100);
  const pages = [];
  let cursor;
  do {
    const result = await call(f, { extra: cursor ? { cursor } : {} });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32 * 1024);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    pages.push(result.structuredContent);
    cursor = result.structuredContent.preference_delivery.next_cursor;
    assert.equal(result.structuredContent.preferences_complete, !cursor);
    assert.ok(pages.length <= 100);
  } while (cursor);
  assert.ok(pages.length > 1);
  assert.equal(new Set(pages.map(page => page.preference_delivery.revision)).size, 1);
  assert.deepEqual(pages.map(page => page.preference_delivery.page_index), pages.map((_, i) => i));
  const value = { ...Object.assign({}, ...pages), effective_preferences: pages.flatMap(page => page.effective_preferences) };
  assert.equal(value.effective_preferences.length, 100);
  assert.deepEqual(value.effective_preferences, f.preferences.effective_preferences.map(agentCollaborationPreference));
  for (let i = 0; i < 100; i++) assert.equal(value.effective_preferences[i].instruction, f.preferences.effective_preferences[i].instruction);
  assert.equal(value.task_context_token, f.task.token);
  assert.equal(value.agent_receipt.owner.agent_id, 'agent-a');
  assert.match(value.task_guidance.checkpoint, /checkpoint/);
  assert.match(value.application_guidance.authority, /authoritative-source confirmed/);
  assert.equal(value.judgment_context.policy.revision, 1);
  const role = value.project_agent_context;
  assert.deepEqual(role.role.initial_preferences, ['ROLE_INITIAL_PREF']);
  assert.deepEqual(role.role.character, { judgment: 'ROLE_JUDGMENT', taste: 'ROLE_TASTE', personality: 'ROLE_PERSONALITY' });
  assert.equal(role.role.expectations, 'ROLE_EXPECTATIONS');
  assert.equal(role.project_brief.summary, 'PROJECT_PURPOSE · PROJECT_BOUNDARY');
  assert.equal(role.reporting_lead_agent_id, 'lead-a');
  assert.match(role.reporting_guidance, /Return results and blockers to reporting_lead_agent_id/);
  assert.equal(role.selection_reason, 'delegated_member');
  for (const key of ['memory', 'global_memory', 'team', 'knowledge', 'recent_tasks']) assert.equal(Object.hasOwn(role, key), false);
  assert.deepEqual(value.active_conflicts, []); assert.deepEqual(value.deferred_conflicts, []);
  assert.equal(f.reads(), pages.length);
});

test('the reader receipt names the Agent first and its role title in brackets', async () => {
  const f = fixture();
  f.rawAgent.profile.display_name = 'Nova Reed';
  const value = (await call(f)).structuredContent;
  assert.match(value.agent_receipt.markdown, /^FULI Agent：\[Nova Reed \\\[Synthetic owner\\\]\]\(/);
});

test('complete reader preserves active and queued conflict alternatives instead of delivering only effective rules', async () => {
  const f = fixture();
  const left = { ...f.preferences.project_preferences[0], id: 'left', preference_key: 'conflict-rule', instruction: 'Left complete instruction' };
  const right = { ...left, id: 'right', instruction: 'Right complete instruction' };
  Object.assign(f.preferences, { effective_preferences: [], project_preferences: [left, right],
    conflicts: [{ preference_key: 'conflict-rule', preference_scope: 'project', preference_project_id: 'project-a', item_ids: ['left', 'right'] }],
    queued_conflicts: [{ conflict_id: 'queued-conflict', status: 'ai_pending', preference_key: 'conflict-rule',
      preference_scope: 'project', preference_project_id: 'project-a', left_item_id: 'left', left_item_kind: 'entity',
      right_item_id: 'right', right_item_kind: 'entity' }] });
  const result = await call(f); assert.notEqual(result.isError, true);
  const value = result.structuredContent;
  assert.deepEqual(value.effective_preferences, []);
  assert.deepEqual(value.active_conflicts[0].alternatives.map(item => item.instruction), [left.instruction, right.instruction]);
  assert.equal(value.deferred_conflicts[0].left.instruction, left.instruction);
  assert.equal(value.deferred_conflicts[0].right.instruction, right.instruction);
});

test('reader rejects unverified hosts and caller scope/session overrides before accessing preferences', async () => {
  for (const options of [{ env: {} }, { sourceApplication: 'cursor' }, { sourceApplication: 'claude_code' },
    { extra: { sessionId: SESSION } }, { extra: { workKind: 'review' } }, { extra: { projectAgentId: 'other' } }]) {
    const f = fixture(); const result = await call(f, options);
    assert.equal(result.isError, true); assert.equal(f.reads(), 0);
  }
});

test('legacy, foreign or completed task records cannot become reader authority', async () => {
  for (const change of [{ preferenceScope: null }, { agentAssignment: null }, { projectAgentId: null }, { sessionId: 'foreign-session' },
    { sourceApplication: 'cursor' }, { checkpoint: { phase: 'complete' } }]) {
    const f = fixture(); Object.assign(f.task, change);
    const result = await call(f); assert.equal(result.isError, true);
    assert.equal(result.structuredContent.effective_preferences, undefined);
  }
});

test('source overflow, oversize instructions and unsafe fields block without delivering preference fragments', async () => {
  for (const [reason, change] of [
    ['source_window', f => { f.preferences.source_windows.candidates_truncated = true; }],
    ['delivery_budget', f => { f.preferences.effective_preferences[0].instruction = '超长\\"'.repeat(200_000); }],
    ['unsafe_projection', f => { f.preferences.effective_preferences[0].attributes = { privatePath: 'DO_NOT_DELIVER_PRIVATE_PATH' }; }]
  ]) {
    const f = fixture(); change(f); const result = await call(f); const value = result.structuredContent;
    assert.notEqual(result.isError, true);
    assert.equal(value.preference_delivery.reason, reason); assert.equal(value.preferences_complete, false);
    assert.equal(value.effective_preferences, undefined); assert.equal(value.task_context_token, f.task.token);
    assert.equal(value.agent_receipt.owner.agent_id, 'agent-a');
    assert.doesNotMatch(result.content[0].text, /END_PREF_|DO_NOT_DELIVER_PRIVATE_PATH/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024);
  }
});

// Keys an entry carries only as continuity evidence or entry-time state; every
// other project_agent_context field is a delivered instruction or identity.
const ENTRY_ONLY_KEYS = ['memory', 'global_memory', 'knowledge', 'recent_tasks', 'team', 'directorySnapshot',
  'details_guidance', 'unavailable_components', 'status', 'wake_mode'];
const withoutEntryOnly = value => Object.fromEntries(Object.entries(value).filter(([key]) => !ENTRY_ONLY_KEYS.includes(key)));
// The entry references shared rule text; resolve it before comparing with full recovery.
const resolvedRules = value => Object.fromEntries(Object.entries(value).map(([key, item]) =>
  [key, typeof item?.rules === 'string' && item.version === entryRules().version
    ? entryRules().sections[item.rules.split('/').at(-1)] : item]));

test('recovered Agent context matches every instruction field of the compacted entry, including team reporting', async () => {
  const f = fixture();
  const entryApp = { ...f.app, searchKnowledge: async () => ({ facts: [], entities: [] }),
    personal: { ...f.app.personal, listProjectAgentTasks: async () => [],
      getProjectAgentMemory: async input => ({ personal_space_id: input.personalSpaceId,
        personal_project_id: input.personalProjectId, agent_id: input.agentId, revision: 0, current: null }) } };
  const selection = { selection_reason: f.task.agentAssignment.selection_reason,
    match_basis: f.task.agentAssignment.match_basis, reporting_lead_agent_id: 'lead-a' };
  const entry = compactTaskContext({ project_agent_context: applyAgentAssignment(await loadProjectAgentContinuity(entryApp, {
    projectId: 'project-a', agent: projectAgentRecord(f.rawAgent), sourceApplication: 'codex',
    selectionReason: selection.selection_reason, matchBasis: selection.match_basis }), selection) }).project_agent_context;
  assert.equal(entry.team_guidance.rules, 'fuli://rules/task-entry/team_guidance');
  const result = await call(f); assert.notEqual(result.isError, true, JSON.stringify(result));
  const recovered = result.structuredContent.project_agent_context;
  assert.deepEqual(withoutEntryOnly(recovered), JSON.parse(JSON.stringify(resolvedRules(withoutEntryOnly(entry)))));
  assert.match(recovered.team_guidance, /sole user-facing owner/);
});

test('fixed role guidance beyond the page envelope budget blocks without a partial role', async () => {
  const f = fixture();
  const tail = (limit, marker) => '𝒜'.repeat(limit - [...marker].length) + marker;
  Object.assign(f.rawAgent.profile.character, { judgment: tail(2048, 'HUMAN_REVIEW_REQUIRED_J') });
  f.rawAgent.profile.expectations = tail(4096, 'HUMAN_REVIEW_REQUIRED_E');
  const result = await call(f); assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent.preferences_complete, false);
  assert.equal(result.structuredContent.preference_delivery.reason, 'delivery_budget');
  assert.equal(result.structuredContent.effective_preferences, undefined);
  assert.doesNotMatch(result.content[0].text, /HUMAN_REVIEW_REQUIRED/);
});

test('role text beyond its bound or an unreadable team blocks instead of delivering a cut role', async () => {
  for (const change of [
    f => { f.rawAgent.profile.character.taste = 'x'.repeat(2048) + 'HUMAN_REVIEW_REQUIRED'; },
    f => { f.rawAgent.profile.expectations = '𝒜'.repeat(4097); },
    f => { f.app.personal.getProjectAgentCoordinationPolicy = async () => { throw new Error('Provider unavailable'); }; }
  ]) {
    const f = fixture(); change(f);
    const result = await call(f);
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.effective_preferences, undefined);
    assert.doesNotMatch(result.content[0].text, /HUMAN_REVIEW_REQUIRED|END_PREF_/);
  }
});


test('reader retries return identical pages and reject forged, cross-token and changed-snapshot cursors', async () => {
  const f = fixture(100);
  const first = await call(f);
  const cursor = first.structuredContent.preference_delivery.next_cursor;
  assert.equal(typeof cursor, 'string');
  assert.deepEqual(await call(f), first);
  const second = await call(f, { extra: { cursor } });
  assert.deepEqual(await call(f, { extra: { cursor } }), second);
  assert.equal((await call(f, { extra: { cursor: cursor + 'forged' } })).isError, true);
  const other = fixture(100); other.task.token = 'fuli-task-other';
  assert.equal((await call(other, { extra: { cursor } })).isError, true);
  // All mandatory content, including role and conflicts, belongs to the revision.
  f.rawAgent.profile.expectations += ' Changed role';
  const stale = await call(f, { extra: { cursor } });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.effective_preferences, undefined);
  assert.notEqual((await call(f)).structuredContent.preference_delivery.revision,
    first.structuredContent.preference_delivery.revision);
});

test('a later oversize preference blocks the first page rather than silently dropping it', async () => {
  const f = fixture(100);
  f.preferences.effective_preferences[99].instruction = 'Oversized synthetic instruction '.repeat(20_000);
  const result = await call(f);
  assert.equal(result.structuredContent.preferences_complete, false);
  assert.equal(result.structuredContent.preference_delivery.status, 'blocked');
  assert.equal(result.structuredContent.effective_preferences, undefined);
  assert.doesNotMatch(result.content[0].text, /END_PREF_/);
});

test('small legacy reader response remains complete without a cursor', async () => {
  const result = await call(fixture());
  assert.equal(result.structuredContent.preferences_complete, true);
  assert.equal(result.structuredContent.preference_delivery.status, 'complete');
  assert.equal(result.structuredContent.effective_preferences.length, 1);
  assert.equal(result.structuredContent.preference_delivery.next_cursor, undefined);
});

test('a continuation reauthorizes before reading cached cursor metadata', async () => {
  const f = fixture(100);
  const first = await call(f);
  const cursor = first.structuredContent.preference_delivery.next_cursor;
  let revokedReads = 0;
  f.app.taskContextRegistry.preferences = async () => {
    revokedReads++;
    throw new Error('Synthetic Provider denied revoked access');
  };
  const result = await call(f, { extra: { cursor } });
  assert.equal(revokedReads, 1);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.effective_preferences, undefined);
  assert.doesNotMatch(result.content[0].text, /END_PREF_/);
});
