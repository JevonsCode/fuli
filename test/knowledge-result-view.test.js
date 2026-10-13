import assert from 'node:assert/strict';
import test from 'node:test';

import { compactKnowledgeItem } from '../src/graphiti/knowledge-item-view.js';
import { compactKnowledgeToolResult } from '../src/mcp/knowledge-result-view.js';
import { withoutRedundantEntryFields } from '../src/conversations/task-entry-trim.js';

const defaults = {
  group_id: 'local-personal-space', space_id: 'space', spaceId: 'space', scope: 'personal', providerUrl: null,
  reasoning_summary: null, preference_project_id: null, preference_agent_id: null, defined_project_id: null,
  project_agent_id: null, inheritance_mode: 'local_only', inherited_project_ids: [], inherited_from_project_id: null,
  scope_distance: 0, scope_path: [], human_edited: false, human_change_status: 'none', human_change_version: 0,
  last_human_changed_at: null, last_agent_viewed_at: null, last_agent_reviewed_at: null, utility_score: 0,
  qualified_use_count: 0, distinct_task_count: 0, last_used_at: null, negative_evidence_count: 0,
  requires_attention: false, last_feedback_kind: null, last_feedback_at: null, source_uris: []
};
const essentials = { id: 'item-1', name: 'Branch rule', type: 'Preference', summary: 'Use JVS/ branches.',
  confirmation_status: 'confirmed', epistemic_status: 'confirmed', confidence_score: 1, score: 8.7,
  confirmation_basis: { existence_reason: 'User asked.', proposed_by: { kind: 'user' }, agent_policy_version: null } };

test('knowledge items omit only governance fields at their exact defaults', () => {
  const view = compactKnowledgeItem({ ...essentials, ...defaults });
  assert.deepEqual(view, { ...essentials, scope: 'personal',
    confirmation_basis: { existence_reason: 'User asked.', proposed_by: { kind: 'user' } } });

  const flagged = compactKnowledgeItem({ ...essentials, ...defaults, human_edited: true, human_change_status: 'pending',
    requires_attention: true, negative_evidence_count: 2, inheritance_mode: 'descendants', scope_distance: 1,
    source_uris: ['https://example.test/doc'], last_feedback_kind: 'outdated' });
  for (const key of ['human_edited', 'human_change_status', 'requires_attention', 'negative_evidence_count',
    'inheritance_mode', 'scope_distance', 'source_uris', 'last_feedback_kind']) {
    assert.ok(Object.hasOwn(flagged, key), key);
  }
  const shared = compactKnowledgeItem({ ...essentials, ...defaults, scope: 'project', spaceId: 'team', providerUrl: 'http://team' });
  assert.equal(shared.spaceId, 'team');
  assert.equal(shared.providerUrl, 'http://team');
});

test('multi-query project search states repeated guidance and markers once', () => {
  const marker = { required: true, status: 'no_match', leadMarkdown: '**[◇ FULI · 已检索，未命中](http://127.0.0.1:2727/)**' };
  const guidance = { markerToUseIfNoSupportingEvidence: 'noMatchSourceMarker', instruction: 'Ask before widening.' };
  const result = (query, extra = {}) => ({ query, sourceMarker: marker, noMatchSourceMarker: { ...marker },
    retrievalGuidance: { ...guidance }, facts: [], entities: [], requestedProjectIds: [], searchedProjectIds: [],
    failedProjectIds: [], subscriptions: [], relatedProjectSuggestions: [], relatedProjectGuidance: null,
    projectAgentId: null, partial: false, ...extra });
  const view = compactKnowledgeToolResult('search_current_project_knowledge', { status: 'searched',
    results: [result('a'), result('b', { partial: true, failedProjectIds: ['team-x'],
      entities: [{ ...essentials, ...defaults }] })],
    related_project_suggestions: [], related_project_guidance: null });

  assert.deepEqual(view.results[0], { query: 'a', sourceMarker: marker, noMatchSourceMarker: marker,
    retrievalGuidance: guidance, facts: [], entities: [] });
  assert.equal(view.results[1].retrievalGuidance, 'same as results[0].retrievalGuidance');
  assert.equal(view.results[1].partial, true);
  assert.deepEqual(view.results[1].failedProjectIds, ['team-x']);
  assert.equal(view.results[1].entities[0].human_edited, undefined);
  assert.match(view.item_field_defaults, /not human-edited/);
  assert.equal(view.related_project_suggestions, undefined);

  const single = compactKnowledgeToolResult('search_knowledge_graph', result('only'));
  assert.deepEqual(single.noMatchSourceMarker, marker);
  assert.equal(single.item_field_defaults, undefined);
  const untouched = { results: [result('x')] };
  assert.equal(compactKnowledgeToolResult('get_project_agent_memory', untouched), untouched);
});

test('hook recall uses the same compact item view', () => {
  const entry = withoutRedundantEntryFields({ task_knowledge_recall: { status: 'matched',
    facts: [], entities: [{ ...essentials, ...defaults }] } });
  assert.deepEqual(Object.keys(entry.task_knowledge_recall.entities[0]).sort(),
    [...Object.keys(essentials), 'scope'].sort());
  assert.match(entry.task_knowledge_recall.item_field_defaults, /local_only/);
});
