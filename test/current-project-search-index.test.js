import assert from 'node:assert/strict';
import test from 'node:test';

import { searchCurrentProjectKnowledge } from '../src/graphiti/current-project-knowledge-search.js';

const node = (name, extra = {}) => ({ id: name, name, type: 'Knowledge', confirmation_status: 'pending', created_at: '2026-11-01T00:00:00.000Z', ...extra });

function application(found, nodes) {
  return { config: { personal: { spaceId: 'space-synthetic' } },
    searchKnowledge: async () => found,
    personal: { graph: async () => ({ nodes, edges: [] }) } };
}
const resolution = { personalProjectId: 'project-synthetic', status: 'matched' };
const search = (app, extra = {}) => searchCurrentProjectKnowledge(app, resolution, { queries: ['synthetic words'], ...extra });

test('a search that matched nothing hands the Agent the titles to judge by meaning', async () => {
  const answer = await search(application({ facts: [], entities: [] }, [
    node('Older pending'), node('Confirmed rule', { confirmation_status: 'confirmed' }),
    node('Newer pending', { created_at: '2026-11-02T00:00:00.000Z' }), node('Ended', { invalid_at: '2026-11-03T00:00:00.000Z' }),
    node('The project', { type: 'PersonalProject' }), node('A preference', { type: 'PersonalPreference' })]));
  assert.deepEqual(answer.knowledge_index.titles, [['Confirmed rule', 'confirmed'], ['Newer pending', 'pending'], ['Older pending', 'pending']]);
  assert.equal(answer.knowledge_index.total, 3);
});

test('a search that matched something sends no titles', async () => {
  const answer = await search(application({ facts: [{ id: 'f', fact: 'Synthetic fact' }], entities: [] }, [node('A title')]));
  assert.equal(answer.knowledge_index, undefined);
});

test('the list is bounded, and a project with no knowledge sends none', async () => {
  const many = Array.from({ length: 90 }, (_, index) => node(`Title ${index} ${'x'.repeat(300)}`));
  const answer = await search(application({ facts: [], entities: [] }, many));
  assert.equal(answer.knowledge_index.titles.length, 40);
  assert.equal(answer.knowledge_index.total, 90);
  assert.ok(answer.knowledge_index.titles.every(([title]) => title.length <= 120));
  assert.equal((await search(application({ facts: [], entities: [] }, []))).knowledge_index, undefined);
});

// rec#125: an address/folder conflict names both projects and how the person settles it.
test('a repository address and folder that name two projects say so instead of workspace advice', async () => {
  const app = application({ facts: [], entities: [] }, []);
  const conflict = await searchCurrentProjectKnowledge(app, { status: 'ambiguous', basis: null, personalProjectId: null,
    candidateCount: 2, reason: 'repository_remote_conflict', candidateProjectIds: ['beta', 'alpha'] }, { queries: ['x'] });
  assert.equal(conflict.status, 'project_unresolved');
  assert.deepEqual(conflict.project_resolution.candidate_project_ids, ['beta', 'alpha']);
  assert.match(conflict.required_action, /address points to project beta and the folder name to project alpha/);
  assert.match(conflict.required_action, /reference/);
  assert.doesNotMatch(conflict.required_action, /workspace children|exact project directory/);
  const other = await searchCurrentProjectKnowledge(app, { status: 'ambiguous', basis: null, personalProjectId: null,
    candidateCount: 2 }, { queries: ['x'] });
  assert.equal(other.project_resolution.reason, undefined);
  assert.match(other.required_action, /workspace children/);
});
