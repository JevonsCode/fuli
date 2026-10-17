import assert from 'node:assert/strict';
import test from 'node:test';
import { errorToolResult, hookAdditionalContextToolResult, successToolResult } from '../src/mcp/tool-result.js';
import { listAgentTools } from '../src/agent-tools.js';
import { jsonSchemaToZod } from '../src/mcp/tool-schema.js';

const options = { hookEventName: 'UserPromptSubmit', label: 'Synthetic task context',
  limitBytes: 128 * 1024, itemLimit: 1000 };

test('lifecycle token and checkpoint requirement remain in the host preview before recovered history', () => {
  const token = 'fuli-task-synthetic-current-preview';
  const receipt = { required: true, markdown: 'FULI Agent: Synthetic owner', owner: { name: 'Synthetic owner' } };
  const payload = { conversation: { recovery: { events: Array.from({ length: 12 }, () => ({
    content: 'Synthetic recovered history. '.repeat(12)
  })) } }, taskContextToken: token, task_context_token: token, checkpoint_required: true,
  agent_receipt: receipt, effective_preferences: [{ instruction: 'Preserve the complete instruction.' }] };
  const result = hookAdditionalContextToolResult(payload, options);
  const context = JSON.parse(result.content[0].text).hookSpecificOutput.additionalContext;
  const preview = Buffer.from(context).subarray(0, 2048).toString('utf8');
  assert.ok(preview.includes(token));
  assert.ok(preview.includes('"checkpoint_required":true'));
  assert.ok(preview.includes(receipt.markdown));
  assert.deepEqual(result.structuredContent, payload);
});

test('the public coordinator accepts the first task token for recruitment handoff', () => {
  const tool = listAgentTools().find(tool => tool.name === 'coordinate_project_agent_task');
  const input = { taskContextToken: 'fuli-task-first-team', projectPath: '/synthetic/project',
    idempotencyKey: 'synthetic-first-team', title: 'Synthetic first task', objective: 'Adopt the recruited role',
    workKind: 'implementation', routingReason: 'Synthetic scope', contextQueries: ['project'] };
  assert.equal(jsonSchemaToZod(tool.inputSchema).safeParse(input).success, true);
});

test('a growing preference collection does not silently truncate employee memory', () => {
  const payload = { taskContextToken: 'fuli-task-synthetic-context',
    effective_preferences: Array.from({ length: 40 }, (_, i) => ({ id: `rule-${i}`, content: 'Scoped instruction '.repeat(40) })),
    project_agent_context: { status: 'ready', memory: { revision: 4, current: {
      memory: { summary: 'Synthetic project history. '.repeat(120) }
    } } } };
  const result = hookAdditionalContextToolResult(payload, options);
  assert.deepEqual(result.structuredContent, payload);
  assert.equal(result.structuredContent.effective_preferences.length, 40);
  assert.equal(JSON.parse(result.content[0].text).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});

test('oversized hook delivery explicitly requires recovery rather than claiming complete context', () => {
  const result = hookAdditionalContextToolResult({ taskContextToken: 'fuli-task-synthetic-context',
    project_agent_context: { memory: { summary: 'x'.repeat(200_000) } } }, options);
  assert.equal(result.structuredContent.truncated, true);
  const context = JSON.parse(result.content[0].text).hookSpecificOutput.additionalContext;
  assert.match(context, /Context delivery is incomplete/);
  assert.match(context, /get_project_agent_memory/);
  assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) <= options.limitBytes);
});

test('task context preview bounds both memory layers with honest truncation metadata', async () => {
  const { compactTaskContext } = await import('../src/conversations/task-context-view.js');
  const layer = (scope, project, revision, summary) => ({ scope, personalProjectId: project, revision,
    current: { revision, memory: { summary, decisions: ['d'.repeat(400), 'b', 'c', 'e'], openThreads: [], nextActions: [] } },
    history: [{ revision: revision - 1, memory: { summary: 'h'.repeat(30_000) } }], workLog: [{ summary: 'w'.repeat(5000) }] });
  const source = { taskContextToken: 'fuli-task-synthetic-dual-preview', project_agent_context: {
    status: 'ready', unavailable_components: [],
    memory: layer('private_agent_project', 'synthetic-project', 3, 'p'.repeat(4000)),
    global_memory: layer('private_agent_global', null, 5, 'Short synthetic global notes.') } };
  const view = compactTaskContext(source).project_agent_context;
  for (const key of ['memory', 'global_memory']) {
    assert.equal(view[key].view, 'preview');
    assert.equal(view[key].history, undefined);
    assert.equal(view[key].workLog, undefined);
    assert.equal(view[key].requiresFullReadBeforeWrite, true);
    assert.equal(view[key].current.memory.decisions.length, 3);
    assert.equal(view[key].notesTruncated, true);
  }
  assert.equal(view.memory.current.memory.summary.length, 800);
  assert.equal(view.global_memory.current.memory.summary, 'Short synthetic global notes.');
  assert.deepEqual([view.memory.revision, view.global_memory.revision], [3, 5]);
  assert.match(view.global_memory.guidance, /personalProjectId: null/);
  const result = hookAdditionalContextToolResult(compactTaskContext(source), options);
  assert.equal(result.structuredContent.truncated, undefined);
  assert.equal(result.structuredContent.project_agent_context.global_memory.revision, 5);
  assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) < 8 * 1024);
});

test('a global-only preview survives when the project layer is unavailable', async () => {
  const { compactTaskContext } = await import('../src/conversations/task-context-view.js');
  const view = compactTaskContext({ project_agent_context: { status: 'degraded', memory: null,
    unavailable_components: ['memory'], knowledge: [{ facts: [] }],
    global_memory: { revision: 2, current: { revision: 2, memory: { summary: 'Synthetic.' } }, history: [{}] } } });
  assert.equal(view.project_agent_context.memory, null);
  assert.equal(view.project_agent_context.global_memory.history, undefined);
  assert.equal(view.project_agent_context.global_memory.notesTruncated, false);
});

test('compact entry preserves executable scope, conflicts and memory revision while deferring board/team details', async () => {
  const { compactTaskContext } = await import('../src/conversations/task-context-view.js');
  const preference = { instruction: 'Only in this exact session', preference_key: 'scoped', preference_scope: 'project',
    preference_project_id: 'parent', preference_agent_id: 'agent-a',
    preference_qualifiers: { sessionId: 'session-a' }, inherited_from_project_id: 'parent',
    scope_distance: 1, scope_path: ['child', 'parent'], confirmation_status: 'agent_confirmed' };
  const conflicts = [{ alternatives: [{ instruction: 'Ask before overwrite' }] }];
  const view = compactTaskContext({ effective_preferences: [preference], active_conflicts: conflicts,
    project_agent_context: { project_agent_id: 'agent-a', role: { name: 'Synthetic Agent' },
      team: { collaborators: [{ privateContext: 'x'.repeat(5000) }] },
      memory: { revision: 7, current: { memory: { summary: 'Current notes' } } } },
    project_management_context: { managers: [{ agent_id: 'manager-a', tools: { discover: 'list_employee_tools', call: 'call_employee_tool' },
      board: { version: 3, total: 60, items: [{ title: 'x'.repeat(5000) }] }, guidance: 'Preserve approval rules' }] }
  });
  for (const field of ['preference_project_id', 'preference_agent_id', 'preference_qualifiers', 'inherited_from_project_id', 'scope_distance', 'scope_path']) {
    assert.deepEqual(view.effective_preferences[0][field], preference[field], field);
  }
  assert.deepEqual(view.active_conflicts, conflicts);
  assert.deepEqual(view.project_agent_context.team, { roster: [] });
  assert.equal(view.project_agent_context.memory.revision, 7);
  assert.equal(view.project_management_context.managers[0].board.items, undefined);
  assert.match(view.project_management_context.managers[0].board.guidance, /read_board/);
});

test('compact preference qualifiers omit retrieval aliases while retaining unknown conditions from legacy attributes', async () => {
  const { compactTaskContext } = await import('../src/conversations/task-context-view.js');
  const view = compactTaskContext({ effective_preferences: [{ instruction: 'Complete rule', preference_qualifiers: {},
    attributes: { searchTerms: ['x'.repeat(2000)], weight: 0.9, preferenceKey: 'rule', instruction: 'Complete rule',
      sessionId: 'synthetic-session', appliesWhen: { unknownRule: 'retain' }, tasteDomain: 'writing' } }] });
  assert.deepEqual(view.effective_preferences[0].preference_qualifiers, {
    sessionId: 'synthetic-session', appliesWhen: { unknownRule: 'retain' }, tasteDomain: 'writing'
  });
  assert.deepEqual(view.effective_preferences[0].attributes, { tasteDomain: 'writing' });
});

test('compact entry preserves Provider-bounded raw messages, flags and source read coordinates', async () => {
  const { compactTaskContext } = await import('../src/conversations/task-context-view.js');
  const checkpoint = { status: 'reported', summary: 'Keep the latest truthful result complete.' };
  const original = { conversation: { conversation_id: 'new-conversation', recovered_from: 'source-conversation', revision: 1,
    recovery: { conversation_id: 'source-conversation', revision: 8, summary: '', summary_role: 'historical', truncated: true,
      omitted_sequence: 2, scan_truncated: false,
      messages: [{ sequence: 3, role: 'assistant', content: 'Recent visible historical message.' }], latest_checkpoint: checkpoint } },
    taskContextToken: 'fuli-task-synthetic-history', effective_preferences: [{ instruction: 'Complete mandatory rule.' }] };
  const view = compactTaskContext(original);
  assert.deepEqual(view.conversation.recovery, original.conversation.recovery);
  assert.equal(view.conversation.recovery.messagesOmitted, undefined);
  assert.equal(view.conversation.recovered_from, 'source-conversation');
  assert.equal(view.conversation.conversation_id, 'new-conversation');
  assert.deepEqual(view.conversation.recovery.latest_checkpoint, checkpoint);
  assert.equal(original.conversation.recovery.messages.length, 1);
});

test('compact entry shares identical retrieval rules but keeps distinct or unknown guidance', async () => {
  const { compactTaskContext } = await import('../src/conversations/task-context-view.js');
  const guidance = { before_reasking: 'Inspect recall before reasking.', scope: 'Exact authorized project only.' };
  const input = { application_guidance: { knowledge_retrieval: guidance },
    task_knowledge_recall: { status: 'no_match', guidance: { ...guidance }, facts: [] } };
  const view = compactTaskContext(input);
  assert.equal(view.task_knowledge_recall.guidance, undefined);
  assert.equal(view.task_knowledge_recall.guidance_ref, 'application_guidance.knowledge_retrieval');
  assert.deepEqual(view.application_guidance.knowledge_retrieval, guidance);
  const distinct = { unknownCondition: 'Keep this full instruction.' };
  assert.deepEqual(compactTaskContext({ ...input, task_knowledge_recall: { guidance: distinct } }).task_knowledge_recall.guidance, distinct);
});

function preferenceEntry() {
  return { taskContextToken: 'fuli-task-synthetic-integrity', task_context_token: 'fuli-task-synthetic-integrity',
    checkpoint_required: true,
    agent_receipt: { required: true, markdown: 'FULI Agent: Synthetic owner', owner: { agent_id: 'agent-a' } },
    context: { personal_space_id: 'space-a', personal_project_id: 'project-a', project_agent_id: 'agent-a', source_truncated: false },
    project_scope: { type: 'registered', personal_project_id: 'project-a' },
    effective_preferences: [{ instruction: 'Complete mandatory instruction.', preference_scope: 'project',
      preference_qualifiers: { workKind: 'implementation' } }],
    active_conflicts: [], deferred_conflicts: [],
    application_guidance: { authority: 'Human confirmation wins.', conflicts: 'Ask the user about relevant unresolved conflicts.' } };
}

test('preference delivery preserves a complete long rule when its full JSON fits', () => {
  const value = preferenceEntry();
  value.effective_preferences[0].instruction = '完整规则😀"\\'.repeat(600);
  assert.deepEqual(hookAdditionalContextToolResult(value, options).structuredContent, value);
});

test('incomplete preference sources or necessary fields fail closed without partial instructions', () => {
  const cases = [
    ['source_window', value => { value.context.source_truncated = true; value.effective_preferences = []; }],
    ['source_window', value => { value.context.source_truncated = true; value.effective_preferences[0].instruction = 'x'.repeat(200_000); }],
    ['delivery_budget', value => { value.effective_preferences[0].instruction = '规则😀'.repeat(40_000); }],
    ['delivery_budget', value => { value.effective_preferences = Array.from({ length: 100 }, () => ({ instruction: 'Long rule. '.repeat(200) })); }],
    ['delivery_budget', value => { value.effective_preferences.push({ instruction: 'Second rule must not disappear.' }); }, { itemLimit: 1 }],
    ['delivery_budget', value => { value.effective_preferences[0].preference_qualifiers = { a: { b: { c: { d: { e: { workKind: 'implementation' } } } } } }; }],
    ['delivery_budget', value => { value.effective_preferences[0].preference_qualifiers = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`condition-${i}`, i])); }],
    ['delivery_budget', value => { value.active_conflicts = [{ alternatives: [{ instruction: 'One' }, { instruction: 'Two' }] }]; }, { itemLimit: 1 }],
    ['delivery_budget', value => { value.application_guidance.authority = 'Authority must remain intact. '.repeat(9000); }]
  ];
  for (const [reason, change, overrides] of cases) {
    const value = preferenceEntry();
    change(value);
    const unchanged = structuredClone(value);
    const result = hookAdditionalContextToolResult(value, { ...options, ...overrides, label: 'Apply effective_preferences.' });
    const data = result.structuredContent;
    assert.equal(data.preferences_complete, false);
    assert.equal(data.same_task_recovery_available, false);
    assert.equal(data.preference_delivery.status, 'blocked');
    assert.equal(data.preference_delivery.reason, reason);
    assert.equal(Object.hasOwn(data, 'effective_preferences'), false);
    for (const key of ['taskContextToken', 'task_context_token', 'checkpoint_required', 'agent_receipt', 'context', 'project_scope']) {
      assert.deepEqual(data[key], value[key], key);
    }
    const text = JSON.parse(result.content[0].text).hookSpecificOutput.additionalContext;
    assert.match(text, /^Fuli preference delivery is blocked/);
    assert.doesNotMatch(text, /Apply effective_preferences|retrieve omitted preference details/);
    assert.ok(Buffer.byteLength(JSON.stringify(data)) <= options.limitBytes);
    assert.deepEqual(value, unchanged);
  }
});

test('unrelated memory clipping does not falsely block complete preferences or change ordinary results', () => {
  const value = preferenceEntry();
  value.project_agent_context = { project_agent_id: 'agent-a', memory: { summary: 'x'.repeat(200_000) } };
  const result = hookAdditionalContextToolResult(value, options);
  assert.equal(result.structuredContent.truncated, true);
  assert.notEqual(result.structuredContent.preferences_complete, false);
  assert.deepEqual(result.structuredContent.effective_preferences, value.effective_preferences);
  assert.deepEqual(successToolResult({ context: { source_truncated: true }, effective_preferences: [] }).structuredContent,
    { context: { source_truncated: true }, effective_preferences: [] });
});

test('real task checkpoint and confirmation guidance cannot be clipped under historical memory pressure', async () => {
  const { beginTaskFromPreferences } = await import('../src/graphiti/agent-knowledge-workflows.js');
  const { compactTaskContext } = await import('../src/conversations/task-context-view.js');
  const value = compactTaskContext(await beginTaskFromPreferences({
    getCapturePolicy: () => ({ enabled: false }),
    taskContextRegistry: { begin: async input => ({ ...input, token: 'fuli-task-synthetic-real-guidance' }) }
  }, preferenceEntry(), { sessionId: 'synthetic-session' }));
  assert.ok(Buffer.byteLength(value.task_guidance.checkpoint) > 512);
  assert.ok(Buffer.byteLength(value.task_guidance.knowledge_routing) > 512);
  value.conversation = { recovery: { messages: [{ role: 'user', content: 'Historical context. '.repeat(12_000) }] } };
  const result = hookAdditionalContextToolResult(value, options).structuredContent;
  assert.equal(result.preference_delivery.reason, 'delivery_budget');
  assert.equal(Object.hasOwn(result, 'effective_preferences'), false);
  assert.equal(result.task_context_token, value.task_context_token);
  const judgment = preferenceEntry();
  judgment.judgment_context = { policy: { mode: 'manual', client: 'codex', authorizationScope: 'Exact authorized scope. '.repeat(9000) } };
  assert.equal(hookAdditionalContextToolResult(judgment, options).structuredContent.preference_delivery.reason, 'delivery_budget');
});

test('blocked delivery retains actual lifecycle and worker identity without inventing a token', () => {
  const value = preferenceEntry();
  value.context.source_truncated = true;
  delete value.taskContextToken;
  delete value.task_context_token;
  delete value.checkpoint_required;
  value.task_lifecycle = { status: 'not_started', reason: 'native_session_required' };
  value.worker_run = { run_id: 'run-a', task_id: 'coordination-a', coordinator_agent_id: 'lead-a' };
  value.project_agent_context = { project_agent_id: 'agent-a', personal_project_id: 'project-a', source_application: 'codex',
    memory: { current: { private: 'Must not be copied into the blocking envelope.' } } };
  const data = hookAdditionalContextToolResult(value, options).structuredContent;
  assert.deepEqual(data.task_lifecycle, value.task_lifecycle);
  assert.deepEqual(data.worker_run, value.worker_run);
  assert.equal(data.project_agent_context.project_agent_id, 'agent-a');
  assert.equal(data.project_agent_context.personal_project_id, 'project-a');
  assert.equal(data.project_agent_context.source_application, 'codex');
  assert.equal(data.project_agent_context.memory, undefined);
  assert.equal(data.taskContextToken, undefined);
  assert.equal(data.task_context_token, undefined);
  assert.equal(data.checkpoint_required, undefined);
});

test('a budget too small for the complete blocked envelope returns no preference fragments', () => {
  const value = preferenceEntry();
  value.context.source_truncated = true;
  assert.throws(() => hookAdditionalContextToolResult(value, { ...options, limitBytes: 32 }),
    error => {
      const result = errorToolResult(error);
      assert.equal(result.isError, true);
      assert.equal(Object.hasOwn(result.structuredContent, 'effective_preferences'), false);
      assert.doesNotMatch(result.content[0].text, /fuli-task-synthetic-integrity|Complete mandatory instruction/);
      return error.code === 'validation' && /complete blocked preference delivery/.test(error.message);
    });
});

test('both native adapters share blocked delivery and preserve the original task token', async () => {
  const { codexLifecycleOutput } = await import('../src/agents/codex/lifecycle-hook.js');
  const { claudeLifecycleOutput } = await import('../src/agents/claude-code/lifecycle-hook.js');
  for (const lifecycle of [codexLifecycleOutput, claudeLifecycleOutput]) {
    for (const sourceTruncated of [false, true]) {
      const value = preferenceEntry();
      value.context.source_truncated = sourceTruncated;
      if (!sourceTruncated) value.effective_preferences[0].instruction = 'Synthetic large preference. '.repeat(9000);
      let calls = 0;
      const output = await lifecycle('UserPromptSubmit', { session_id: 'synthetic-session', cwd: '/synthetic', prompt: 'Synthetic task' },
        async name => { assert.equal(name, 'begin_task_context'); calls++; return value; });
      const text = output.hookSpecificOutput.additionalContext;
      const data = JSON.parse(text.slice(text.indexOf('\n') + 1));
      assert.match(text, /^Fuli preference delivery is blocked/);
      assert.equal(data.preference_delivery.reason, sourceTruncated ? 'source_window' : 'delivery_budget');
      assert.equal(data.task_context_token, value.task_context_token);
      assert.equal(Object.hasOwn(data, 'effective_preferences'), false);
      assert.equal(calls, 1);
    }
  }
});
