// get_collaboration_preferences for a client that reads FULI only through MCP
// tools (docs/session-preference-delivery.md, MCP-only clients): bounded as a
// hook entry is, and no second copy of the preferences in one conversation.
// Every preference, session and path here is synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { MCP_ENTRY_INLINE_CHARS, MCP_UNCHANGED_INLINE_CHARS, UNCHANGED_LABEL } from '../src/mcp/task-entry-budget.js';
import { OMITTED_CONFLICTS_LABEL, OMITTED_PREFERENCES_LABEL } from '../src/conversations/entry-inline-budget.js';
import { CONDITIONAL_LABEL } from '../src/conversations/preference-conditions.js';
import { readTaskPreferences } from '../src/graphiti/task-preference-reader.js';
import { preferenceAlwaysInline } from '../src/graphiti/preference-task-scope.js';
import { HABITS_LEAD, preparedHabits } from '../src/graphiti/turn-receipt-delivery.js';
import { REAL_SCALE_CASE_PROMPT, realScalePreferences, syntheticLargeEntry, syntheticWorkingEntry }
  from '../test-support/synthetic-large-entry.js';
import { withPreferenceScope } from '../src/conversations/preference-snapshot.js';

const SESSION = '019fc6ed-02a5-7832-8821-68e3b03e7c01';
const TOKEN = 'fuli-task-6f1d2c3b-8a4e-4f5d-9b0c-1e2f3a4b5c6d';
const HABITS = `${HABITS_LEAD}${preparedHabits(70)} · [看看是哪几条](http://127.0.0.1:4318/habits/synthetic)`;

// The Provider's answer for the synthetic working lead: its entry, and the
// task record and preferences the same-task reader replays.
function fixture(items = realScalePreferences(), { entry: build = syntheticWorkingEntry } = {}) {
  let current = items;
  let workKind = 'implementation';
  const task = { token: TOKEN, sessionId: SESSION, sourceApplication: 'codex', personalProjectId: 'project',
    projectAgentId: 'lead', preferenceScope: { version: 1, work_kind: 'implementation', workflow: null }, checkpoint: null,
    agentAssignment: { version: 1, selection_reason: 'project_lead', match_basis: ['Synthetic lead.'],
      requested_agent_id: null, reporting_lead_agent_id: null, execution_reason: null, execution_agent_id: null } };
  const entries = [];
  const app = { config: { personal: { spaceId: 'synthetic-space' } },
    getCollaborationPreferences: async input => {
      entries.push(input);
      const entry = await build({ items: current, sessionId: SESSION, token: TOKEN });
      // The scene the producer keeps beside the entry, as the real entry builder does.
      return withPreferenceScope({ ...entry, context: { personal_space_id: 'synthetic-space', ...entry.context },
        agent_receipt: { ...entry.agent_receipt, markdown: `${entry.agent_receipt.markdown}\n${HABITS}` } },
      { personal_space_id: 'synthetic-space', personal_project_id: 'project', project_agent_id: 'lead', session_id: SESSION,
        source_application: 'codex', preference_scope: { version: 1, work_kind: workKind, workflow: null } });
    },
    taskContextRegistry: {
      preferences: async () => ({ task: structuredClone(task), preferences: { personal_space_id: 'synthetic-space',
        personal_project_id: 'project', project_agent_id: 'lead', effective_preferences: structuredClone(current),
        conflicts: [], queued_conflicts: [], truncated: false,
        source_windows: { candidates_truncated: false, project_ancestors_truncated: false, queued_conflicts_truncated: false } } }),
      context: async () => structuredClone(task),
      currentTaskSession: async () => SESSION
    },
    personal: { getProjectAgent: async () => ({ agent_id: 'lead', profile: { name: 'Synthetic lead', status: 'active',
      allowed_clients: ['codex'] } }),
    getProjectAgentCoordinationPolicy: async () => ({}), listProjectAgents: async () => [],
    getPersonalProject: async () => ({ profile: { name: 'Synthetic project' } }) },
    judgment: { policy: async () => ({ mode: 'manual', client: 'codex', revision: 1 }) }
  };
  app.readTaskPreferences = input => readTaskPreferences(app, input);
  return { app, entries, change: next => { current = next; }, scene: kind => { workKind = kind; } };
}

function server(app, options = {}) {
  return createMcpServer(app, { env: { CODEX_THREAD_ID: SESSION }, sourceApplication: 'codex', registerResources: false,
    toolNames: ['get_collaboration_preferences', 'read_task_preferences'], ...options });
}

async function call(mcp, name, args) {
  const result = await mcp.server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name, arguments: args } },
    { signal: new AbortController().signal, requestId: 1 });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result;
}

const enter = (mcp, extra = {}) => call(mcp, 'get_collaboration_preferences',
  { projectPath: '/synthetic/project', taskPrompt: 'why does the config dialog appear', sessionId: SESSION, ...extra });
const hardKeys = items => items.filter(preferenceAlwaysInline).map(item => item.preference_key).sort();
// The habits of the real-scale set whose stated case ("只在改动交付流程时适用")
// a question about a config dialog is not: each is named by a line, not a body
// (preference-conditions.js). Three of them are hard rules.
const cased = items => items.filter(item => item.preference_qualifiers.appliesWhen);
const casedKeys = items => cased(items).map(item => item.preference_key).sort();
const lineKey = line => line.split(' — ')[0].replace(/ \(\w+\)$/u, '');

test('an MCP entry is bounded to the inline limit with every hard rule, the rest named and readable', async () => {
  const f = fixture();
  const mcp = server(f.app);
  try {
    const result = await enter(mcp);
    const frame = result.structuredContent;
    const all = realScalePreferences();
    assert.ok(result.content[0].text.length <= MCP_ENTRY_INLINE_CHARS, `${result.content[0].text.length}`);
    // Every hard rule's body, in full, but those whose stated case this question is not: those
    // are named by their case, with the rest of such habits (none of them a body).
    const unmet = casedKeys(all);
    for (const rule of all.filter(preferenceAlwaysInline).filter(item => !unmet.includes(item.preference_key))) {
      assert.equal(frame.effective_preferences.find(item => item.preference_key === rule.preference_key)?.instruction,
        rule.instruction);
    }
    // The 3 hard rules among them keep their lines, saying what each says; the other 9 lines
    // would cost bodies this question may need, so those are counted (the read serves them).
    const unmetHard = hardKeys(all).filter(key => unmet.includes(key));
    assert.deepEqual(frame.preferences_omitted.conditional.map(lineKey).sort(), unmetHard);
    for (const line of frame.preferences_omitted.conditional) {
      const item = all.find(each => each.preference_key === lineKey(line));
      assert.ok(line.includes(' — hard rule · '), line);
      assert.ok(line.endsWith(` · ${item.instruction.split('。')[0]}`) || line.endsWith('…'), line);
    }
    assert.equal(frame.effective_preferences.some(item => unmet.includes(item.preference_key)), false);
    assert.match(frame.omitted_guidance, /preferences_omitted\.conditional/);
    const listed = frame.effective_preferences.length;
    assert.ok(listed >= hardKeys(all).length - 3 && listed < all.length, `${listed}`);
    assert.equal(frame.preferences_omitted.count, all.length - listed);
    assert.deepEqual(frame.preferences_omitted.read.tool, 'read_task_preferences');
    assert.equal(frame.preferences_omitted.read.arguments.taskContextToken, TOKEN);
    assert.match(frame.omitted_guidance, /preferences_omitted/);
    assert.match(frame.preferences_revision, /^[0-9a-f]{12}$/);
    assert.equal(frame.next_call, `knownRevision=${frame.preferences_revision}`);
    assert.ok(Buffer.byteLength(`,"next_call":${JSON.stringify(frame.next_call)}`) <= 41);
    // A real-scale working entry names every preference it leaves out with a line and its gist, not a count or keys alone.
    assert.equal(frame.preferences_omitted.index.length + unmet.length, frame.preferences_omitted.count);
    const byKey = new Map(all.map(item => [item.preference_key, item]));
    for (const line of frame.preferences_omitted.index) {
      const [name, gist] = line.split(' — ');
      const key = name.replace(/ \(\w+\)$/u, '');
      assert.ok(byKey.has(key) && !frame.effective_preferences.some(item => item.preference_key === key), line);
      assert.ok(gist && byKey.get(key).instruction.startsWith(gist.replace(/….*$/u, '')), line);
    }
    assert.ok(frame.agent_receipt.markdown.split('\n')[1].startsWith(
      `${HABITS_LEAD}这个新对话为你准备了 70 条习惯：直接带上 ${listed} 条，另外 ${70 - listed} 条随时可读（12 条这次用不上） · `));
    // The entry never sees the transport's own argument.
    await enter(mcp, { knownRevision: 'abc' });
    assert.equal(Object.hasOwn(f.entries.at(-1), 'knownRevision'), false);
  } finally { await mcp.close(); }
});

test('read_task_preferences still pages every preference of the bounded entry', async () => {
  const f = fixture();
  const mcp = server(f.app);
  try {
    const frame = (await enter(mcp)).structuredContent;
    const keys = [];
    let cursor;
    do {
      const page = (await call(mcp, 'read_task_preferences', { ...frame.preferences_omitted.read.arguments,
        ...(cursor ? { cursor } : {}) })).structuredContent;
      keys.push(...page.effective_preferences.map(item => item.preference_key));
      cursor = page.preference_delivery?.next_cursor;
    } while (cursor);
    assert.deepEqual(keys.sort(), realScalePreferences().map(item => item.preference_key).sort());
  } finally { await mcp.close(); }
});

test('the same revision again repeats only the hard rules, with the read; another or none delivers again', async () => {
  const f = fixture();
  const mcp = server(f.app);
  try {
    const first = (await enter(mcp)).structuredContent;
    const again = await enter(mcp, { knownRevision: first.preferences_revision });
    const frame = again.structuredContent;
    const all = realScalePreferences();
    const unmetHard = hardKeys(all).filter(key => casedKeys(all).includes(key));
    assert.deepEqual(frame.effective_preferences.map(item => item.preference_key).sort(),
      hardKeys(all).filter(key => !unmetHard.includes(key)));
    // The hard rules whose case this is not are repeated as their lines.
    assert.deepEqual(frame.preferences_omitted.conditional.map(lineKey).sort(), unmetHard);
    assert.equal(frame.preferences_revision, first.preferences_revision);
    assert.equal(frame.preferences_omitted.unchanged, true);
    assert.equal(frame.preferences_omitted.count, 70 - hardKeys(all).length + unmetHard.length);
    assert.equal(frame.preferences_omitted.index, undefined);
    assert.equal(frame.preferences_omitted.read.arguments.taskContextToken, TOKEN);
    assert.equal(frame.preferences_omitted.index_unchanged, true);
    // The rest still apply: it says to read them, and how to get the index back after a compaction.
    assert.equal(frame.omitted_guidance, [UNCHANGED_LABEL, OMITTED_PREFERENCES_LABEL, CONDITIONAL_LABEL, OMITTED_CONFLICTS_LABEL]
      .slice(0, frame.active_conflicts_omitted ? 4 : 3).join(' '));
    assert.match(frame.omitted_guidance, /without knownRevision/);
    assert.equal(frame.next_call, `knownRevision=${first.preferences_revision}`);
    // This turn's own fields still come, its receipt counting what this answer carries.
    assert.equal(frame.taskContextToken, TOKEN);
    assert.ok(frame.agent_receipt.markdown.includes(`直接带上 ${frame.effective_preferences.length} 条，`));
    // The room the bodies leave goes to this turn's own context (recall, conversation), never past the limit.
    assert.ok(again.content[0].text.length <= MCP_UNCHANGED_INLINE_CHARS, `${again.content[0].text.length}`);
    for (const knownRevision of [undefined, 'f'.repeat(12)]) {
      const full = (await enter(mcp, knownRevision ? { knownRevision } : {})).structuredContent;
      assert.deepEqual(full.effective_preferences, first.effective_preferences);
      assert.equal(full.preferences_omitted.unchanged, undefined);
    }
  } finally { await mcp.close(); }
});

test('a preference changed between two calls changes the revision and delivers again', async () => {
  const f = fixture();
  const mcp = server(f.app);
  try {
    const first = (await enter(mcp)).structuredContent;
    const items = realScalePreferences();
    items[1] = { ...items[1], instruction: `${items[1].instruction} 合成改动。` };
    f.change(items);
    const next = (await enter(mcp, { knownRevision: first.preferences_revision })).structuredContent;
    assert.notEqual(next.preferences_revision, first.preferences_revision);
    assert.equal(next.preferences_omitted.unchanged, undefined);
    assert.equal(next.omitted_guidance.includes(UNCHANGED_LABEL), false);
  } finally { await mcp.close(); }
});

test('another work kind in the same session changes the revision and delivers again', async () => {
  const f = fixture();
  const mcp = server(f.app);
  try {
    const first = (await enter(mcp)).structuredContent;
    f.scene('review');
    const next = (await enter(mcp, { knownRevision: first.preferences_revision })).structuredContent;
    assert.notEqual(next.preferences_revision, first.preferences_revision);
    assert.equal(next.preferences_omitted.unchanged, undefined);
  } finally { await mcp.close(); }
});

test('an entry of preferences alone gives the room a working entry spends on its role to more bodies', async () => {
  const working = server(fixture().app);
  const alone = server(fixture(realScalePreferences(), { entry: async options => syntheticLargeEntry(options) }).app);
  try {
    const rich = (await enter(working)).structuredContent;
    const result = await enter(alone);
    const lean = result.structuredContent;
    assert.ok(result.content[0].text.length <= MCP_ENTRY_INLINE_CHARS);
    assert.ok(lean.effective_preferences.length > rich.effective_preferences.length,
      `${lean.effective_preferences.length} > ${rich.effective_preferences.length}`);
    const unmet = casedKeys(realScalePreferences()).length;
    assert.equal(lean.preferences_omitted.index.length + unmet, lean.preferences_omitted.count);
  } finally { await working.close(); await alone.close(); }
});

test('a revision from another session never matches', async () => {
  const f = fixture();
  const one = server(f.app);
  const other = server(f.app, { env: { CODEX_THREAD_ID: '019fc6ed-02a5-7832-8821-68e3b03e7c02' } });
  try {
    const first = (await enter(one)).structuredContent;
    const elsewhere = (await enter(other, { knownRevision: first.preferences_revision })).structuredContent;
    assert.notEqual(elsewhere.preferences_revision, first.preferences_revision);
    assert.equal(elsewhere.preferences_omitted.unchanged, undefined);
  } finally { await one.close(); await other.close(); }
});

test('the chat profile bounds its entry: read_task_preferences is reached through fuli_call', async () => {
  const f = fixture();
  const mcp = createMcpServer(f.app, { env: {}, toolProfile: 'chat', registerResources: false });
  try {
    const frame = (await enter(mcp)).structuredContent;
    assert.ok(frame.preferences_omitted.count > 0);
    assert.ok(frame.preferences_omitted.read.call);
  } finally { await mcp.close(); }
});

test('an entry stays whole where what a bound leaves out could not be read', async () => {
  // A server without read_task_preferences (as the remote connector), and an entry without a task token.
  const f = fixture();
  const noReader = server(f.app, { toolNames: ['get_collaboration_preferences'] });
  try {
    const frame = (await enter(noReader)).structuredContent;
    assert.equal(frame.effective_preferences.length, 70);
    assert.equal(frame.preferences_omitted, undefined);
    assert.equal(frame.preferences_revision, undefined);
  } finally { await noReader.close(); }
  const tokenless = { ...f.app, getCollaborationPreferences: async input => {
    const { taskContextToken: _token, task_context_token: _snake, ...rest } = await f.app.getCollaborationPreferences(input);
    return rest;
  } };
  const mcp = server(tokenless);
  try {
    const frame = (await enter(mcp)).structuredContent;
    assert.equal(frame.effective_preferences.length, 70);
    assert.equal(frame.preferences_revision, undefined);
  } finally { await mcp.close(); }
});

// A habit left out because the question is not its stated case: a later
// question that is that case changes the revision, so its body arrives rather
// than "unchanged"; read_task_preferences reads it by key at any time.
test('a question that becomes a habit\'s stated case changes the revision and delivers its body; its key reads it', async () => {
  const f = fixture();
  const mcp = server(f.app);
  try {
    const all = realScalePreferences();
    const unmetHard = hardKeys(all).filter(key => casedKeys(all).includes(key));
    const first = (await enter(mcp)).structuredContent;
    assert.equal(first.effective_preferences.some(item => unmetHard.includes(item.preference_key)), false);
    const same = (await enter(mcp, { knownRevision: first.preferences_revision, taskPrompt: 'why does the settings dialog open twice' }))
      .structuredContent;
    assert.equal(same.preferences_omitted.unchanged, true, 'still not the case: unchanged');
    const now = (await enter(mcp, { knownRevision: first.preferences_revision, taskPrompt: REAL_SCALE_CASE_PROMPT })).structuredContent;
    assert.notEqual(now.preferences_revision, first.preferences_revision);
    assert.equal(now.preferences_omitted.unchanged, undefined);
    for (const key of unmetHard) assert.ok(now.effective_preferences.some(item => item.preference_key === key), key);
    assert.equal(now.preferences_omitted.conditional, undefined);
    const read = (await call(mcp, 'read_task_preferences', { ...first.preferences_omitted.read.arguments, keys: unmetHard }))
      .structuredContent;
    assert.deepEqual(read.effective_preferences.map(item => item.preference_key).sort(), unmetHard);
  } finally { await mcp.close(); }
});
