import assert from 'node:assert/strict';
import test from 'node:test';

import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { entryRules, entryRulesMarkdown } from '../src/conversations/entry-rules.js';
import { RECEIPT_GUIDANCE } from '../src/agents/identity-receipt.js';
import { preferenceScopeGuidance, STATIC_APPLICATION_GUIDANCE } from '../src/graphiti/collaboration-preference-workflow.js';

const receipt = {
  required: true,
  markdown: 'FULI Agent：负责人 [Lead](<http://127.0.0.1:2727/agents/space/lead>)',
  owner: { agent_id: 'lead', name: 'Lead', profile_url: 'http://127.0.0.1:2727/agents/space/lead', source_application: 'codex' },
  collaborators: [], personal_project_id: 'sample', work_status: null, persistence: null,
  continuation: { personal_project_id: 'sample', agent_id: 'lead', prompt: '@{lead} continue', guidance: 'x' },
  guidance: RECEIPT_GUIDANCE
};

function entry(overrides = {}) {
  return {
    taskContextToken: 'fuli-task-1',
    context: { personal_space_id: 'space', personal_project_id: 'sample', project_agent_id: 'lead',
      global_preference_count: 2, conflict_count: 0, source_truncated: false,
      source_windows: { candidates_truncated: false, project_ancestors_truncated: true } },
    application_guidance: { ...preferenceScopeGuidance('sample', 'lead'), ...STATIC_APPLICATION_GUIDANCE },
    agent_receipt: receipt,
    project_agent_context: { status: 'ready', worker_started: false, selection_reason: null, match_basis: [],
      role: { name: 'Lead', initial_preferences: [], expectations: '' },
      memory: { revision: 0, current: null }, global_memory: null, team: { roster: [] } },
    ...overrides
  };
}

test('the entry receipt keeps what must be copied and references its rule', () => {
  const view = compactTaskContext(entry()).agent_receipt;
  assert.deepEqual(Object.keys(view).sort(), ['guidance', 'markdown', 'required']);
  assert.equal(view.markdown, receipt.markdown);
  assert.equal(view.guidance.rules, 'fuli://rules/task-entry/receipt_guidance');
  const helped = compactTaskContext(entry({ agent_receipt: { ...receipt,
    collaborators: [{ agent_id: 'qa', name: 'QA' }], work_status: 'completed' } })).agent_receipt;
  assert.deepEqual(helped.collaborators, [{ agent_id: 'qa', name: 'QA' }]);
  assert.equal(helped.work_status, 'completed');
});

test('context drops zero counts and off-flags but keeps IDs and real truncation', () => {
  const view = compactTaskContext(entry()).context;
  assert.deepEqual(view, { personal_space_id: 'space', personal_project_id: 'sample', project_agent_id: 'lead',
    global_preference_count: 2, source_windows: { project_ancestors_truncated: true } });
});

test('scope lines become a reference only when they match the template for these IDs', () => {
  const view = compactTaskContext(entry()).application_guidance;
  assert.equal(view.scope_rules, 'fuli://rules/task-entry/scope_guidance');
  for (const key of ['apply', 'global_scope', 'project_scope', 'agent_scope']) assert.equal(key in view, false, key);
  const custom = { ...preferenceScopeGuidance('sample', 'lead'), ...STATIC_APPLICATION_GUIDANCE, project_scope: 'Custom scope.' };
  const kept = compactTaskContext(entry({ application_guidance: custom })).application_guidance;
  assert.equal(kept.project_scope, 'Custom scope.');
  assert.equal(kept.apply, 'effective_preferences');
  assert.equal('scope_rules' in kept, false);
});

test('Agent context keeps memory states, revision 0 and flags while dropping empties', () => {
  const view = compactTaskContext(entry()).project_agent_context;
  assert.equal(view.worker_started, false);
  assert.equal(view.memory.revision, 0);
  assert.equal(view.global_memory, null);
  assert.deepEqual(view.team, { roster: [] });
  assert.equal('selection_reason' in view, false);
  assert.equal('match_basis' in view, false);
  assert.deepEqual(view.role, { name: 'Lead' });
});

test('sealed workers keep the full entry text', () => {
  const view = compactTaskContext(entry({ worker_run: { id: 'run-1' } }));
  assert.equal(view.agent_receipt.owner.agent_id, 'lead');
  assert.equal(view.context.source_truncated, false);
});

test('the rules resource carries the referenced scope, receipt and details text', () => {
  const { sections } = entryRules();
  assert.equal(sections.receipt_guidance, RECEIPT_GUIDANCE);
  assert.match(sections.scope_guidance.project_scope, /context\.personal_project_id/);
  assert.match(sections.details_guidance, /get_project_team/);
  assert.match(entryRulesMarkdown(), /## scope_guidance/);
});

test('an exact local preference omits default scope fields; real inheritance stays', async () => {
  const { preferenceInstructionView } = await import('../src/conversations/preference-view.js');
  const local = { instruction: 'Use JVS/ branches.', preference_key: 'git-branch-naming', preference_scope: 'global',
    confirmation_status: 'confirmed', profile_aspect: null, inherited_from_project_id: null, scope_distance: 0,
    scope_path: [], inheritance_mode: 'local_only', inherited_project_ids: [] };
  assert.deepEqual(preferenceInstructionView(local), { instruction: 'Use JVS/ branches.',
    preference_key: 'git-branch-naming', preference_scope: 'global', confirmation_status: 'confirmed' });
  const inherited = { ...local, preference_scope: 'project', inherited_from_project_id: 'parent', scope_distance: 1,
    scope_path: ['parent'], inheritance_mode: 'descendants', profile_aspect: 'taste' };
  const view = preferenceInstructionView(inherited);
  assert.equal(view.inherited_from_project_id, 'parent');
  assert.equal(view.scope_distance, 1);
  assert.deepEqual(view.scope_path, ['parent']);
  assert.equal(view.inheritance_mode, 'descendants');
  assert.equal(view.profile_aspect, 'taste');
  assert.ok(JSON.stringify(local).length - JSON.stringify(preferenceInstructionView(local)).length > 120);
});
