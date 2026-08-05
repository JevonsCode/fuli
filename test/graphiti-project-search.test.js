import assert from 'node:assert/strict';
import test from 'node:test';

import {
  searchCurrentProjectKnowledge
} from '../src/graphiti/agent-knowledge-workflows.js';
import {
  relatedProjectSuggestions,
  relatedProjectSuggestionsForSearchResults
} from '../src/graphiti/related-project-suggestions.js';

test('current-project search suggests RELATED_TO expansion without searching it', async () => {
  const searches = [];
  const graphReads = [];
  const application = {
    config: { personal: { spaceId: 'personal-space' } },
    searchKnowledge: async (input) => {
      searches.push(input);
      return { query: input.query, entities: [], facts: [] };
    },
    personal: {
      graph: async (spaceId, limit, personalProjectId) => {
        graphReads.push({ spaceId, limit, personalProjectId });
        return {
          nodes: [
            {
              id: 'personal-project:c',
              name: '关联项目 C',
              type: 'PersonalProject',
              attributes: { projectId: 'related-c' }
            },
            {
              id: 'personal-project-related:travel-d',
              name: '旅行套餐 D',
              type: 'RelatedPersonalProject',
              attributes: { projectId: 'travel-d' }
            }
          ],
          edges: [{
            id: 'personal-project-relation:c-to-d',
            source: 'personal-project:c',
            target: 'personal-project-related:travel-d',
          type: 'RELATED_TO',
          fact: '关联项目 C 与旅行套餐 D 显式关联。',
          attributes: {
            status: 'active',
            confirmationAuthority: 'human_review'
          }
          }]
        };
      }
    }
  };

  const result = await searchCurrentProjectKnowledge(application, {
    status: 'matched',
    basis: 'repository_root',
    personalProjectId: 'related-c'
  }, {
    queries: ['旅行套餐项目关系锚点'],
    includePending: true
  });

  assert.deepEqual(searches.map(({ personalProjectId }) => personalProjectId), ['related-c']);
  assert.deepEqual(graphReads, [{
    spaceId: 'personal-space',
    limit: 2000,
    personalProjectId: 'related-c'
  }]);
  assert.deepEqual(result.related_project_suggestions, [{
    personal_project_id: 'travel-d',
    project_name: '旅行套餐 D',
    relation_id: 'personal-project-relation:c-to-d',
    relation_type: 'RELATED_TO',
    relation_status: 'active',
    direction: 'outgoing',
    reason: '关联项目 C 与旅行套餐 D 显式关联。',
    requires_human_confirmation: true,
    expansion_mode: 'one_time_read_only',
    confirmed_search: {
      tool: 'search_knowledge_graph',
      personal_project_scope: 'bounded',
      context_personal_project_ids: ['travel-d']
    }
  }]);
  assert.equal(result.scope_policy.unrelated_relations_expand_scope, false);
  assert.equal(result.scope_policy.related_project_expansion_requires_confirmation, true);
  assert.match(result.related_project_guidance, /travel-d/);
});

test('current-project search excludes inheritable relations from optional expansions', async () => {
  const application = {
    config: { personal: { spaceId: 'personal-space' } },
    searchKnowledge: async (input) => ({ query: input.query, entities: [], facts: [] }),
    personal: {
      graph: async () => ({
        nodes: [
          {
            id: 'personal-project:d',
            name: 'D',
            type: 'PersonalProject',
            attributes: { projectId: 'travel-d' }
          },
          {
            id: 'personal-project-related:a',
            name: 'A',
            type: 'RelatedPersonalProject',
            attributes: { projectId: 'platform-a' }
          }
        ],
        edges: [{
          id: 'personal-project-relation:d-to-a',
          source: 'personal-project:d',
          target: 'personal-project-related:a',
          type: 'PART_OF',
          fact: 'D 属于 A。'
        }]
      })
    }
  };

  const result = await searchCurrentProjectKnowledge(application, {
    status: 'matched',
    basis: 'repository_root',
    personalProjectId: 'travel-d'
  }, { queries: ['共享上下文'] });

  assert.deepEqual(result.related_project_suggestions, []);
  assert.equal(result.related_project_guidance, null);
});

test('optional relation lookup failure does not suppress bounded project search', async () => {
  const application = {
    config: { personal: { spaceId: 'personal-space' } },
    searchKnowledge: async (input) => ({
      query: input.query,
      entities: [{ id: 'local-result' }],
      facts: []
    }),
    personal: {
      graph: async () => {
        throw new Error('optional graph projection unavailable');
      }
    }
  };

  const result = await searchCurrentProjectKnowledge(application, {
    status: 'matched',
    basis: 'repository_root',
    personalProjectId: 'related-c'
  }, { queries: ['本地事实'] });

  assert.equal(result.status, 'searched');
  assert.equal(result.results[0].entities[0].id, 'local-result');
  assert.deepEqual(result.related_project_suggestions, []);
  assert.equal(result.related_project_suggestions_status, 'unavailable');
});

test('related-project suggestions require an active human-authorized relation', () => {
  const graph = relatedGraphFixture([
    { id: 'active', status: 'active', authority: 'human_review' },
    { id: 'active-agent', status: 'active', authority: 'agent_policy', target: 'travel-agent' },
    { id: 'pending', status: 'pending', target: 'travel-pending' },
    { id: 'rejected', status: 'rejected', target: 'travel-rejected' }
  ]);

  const suggestions = relatedProjectSuggestions(graph, 'related-c');

  assert.deepEqual(suggestions.map(({ personal_project_id: id }) => id), ['travel-d']);
  assert.equal(suggestions[0].relation_status, 'active');
  assert.deepEqual(suggestions[0].confirmed_search, {
    tool: 'search_knowledge_graph',
    personal_project_scope: 'bounded',
    context_personal_project_ids: ['travel-d']
  });
});

test('global result from C offers a bounded D follow-up without expanding automatically', () => {
  const graph = relatedGraphFixture([{
    id: 'active',
    status: 'active',
    authority: 'human_review'
  }]);

  const suggestions = relatedProjectSuggestionsForSearchResults(graph, {
    facts: [{
      id: 'fact-c',
      defined_project_id: 'related-c',
      inherited_from_project_id: null,
      scope_distance: 0
    }],
    entities: []
  });

  assert.deepEqual(suggestions, [{
    personal_project_id: 'travel-d',
    project_name: 'D',
    relation_id: 'personal-project-relation:active',
    relation_type: 'RELATED_TO',
    relation_status: 'active',
    direction: 'outgoing',
    reason: 'C 与 D 显式关联。',
    requires_human_confirmation: true,
    expansion_mode: 'one_time_read_only',
    confirmed_search: {
      tool: 'search_knowledge_graph',
      personal_project_scope: 'bounded',
      context_personal_project_ids: ['travel-d']
    },
    triggered_by_project_id: 'related-c',
    triggered_by_result_ids: ['fact-c']
  }]);
});

function relatedGraphFixture(relations) {
  const projects = new Set(['related-c', ...relations.map(({ target = 'travel-d' }) => target)]);
  return {
    nodes: [...projects].map((projectId) => ({
      id: `personal-project:${projectId}`,
      name: projectId === 'related-c' ? 'C' : projectId === 'travel-d' ? 'D' : projectId,
      type: 'PersonalProject',
      attributes: { projectId }
    })),
    edges: relations.map(({
      id,
      status,
      authority = null,
      target = 'travel-d'
    }) => ({
      id: `personal-project-relation:${id}`,
      source: 'personal-project:related-c',
      target: `personal-project:${target}`,
      type: 'RELATED_TO',
      fact: target === 'travel-d' ? 'C 与 D 显式关联。' : `C 与 ${target} 关联。`,
      attributes: { status, confirmationAuthority: authority }
    }))
  };
}
