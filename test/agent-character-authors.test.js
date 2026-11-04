import assert from 'node:assert/strict';
import test from 'node:test';

import { upsertProjectAgent } from '../src/graphiti/project-agent-workflows.js';
import { PERSON_WRITER } from '../src/graphiti/project-profile-authors.js';

// Synthetic Provider double: it answers with what it was given.
function application(stored) {
  const writes = [];
  return { writes, personal: {
    getProjectAgent: async () => (stored ? { profile: stored } : Promise.reject(new Error('not found'))),
    upsertProjectAgent: async (body) => { writes.push(body); return { agent_id: body.agent_id, personal_space_id: body.personal_space_id, profile: body.profile }; }
  } };
}
const input = (character, writer) => ({ personalSpaceId: 'space-a', agentId: 'alpha', writer,
  profile: { name: 'Aster', responsibility: 'Synthetic role', character } });

test('a preference an Agent writes is recorded as the Agent\'s', async () => {
  const app = application(null);
  await upsertProjectAgent(app, input({ judgment: 'Verify first.', taste: '', personality: '' }, { kind: 'agent', agentId: 'alpha', agentName: 'Aster' }));
  assert.equal(app.writes[0].profile.character_authors.judgment.kind, 'agent');
  assert.equal(app.writes[0].profile.character_authors.judgment.agent_name, 'Aster');
  assert.equal(app.writes[0].profile.character_authors.taste, undefined);
});

test('a person who edits an AI preference shares it, and an Agent then leaves it alone', async () => {
  const stored = { character: { judgment: 'Verify every change first.', taste: '', personality: '' },
    character_authors: { judgment: { kind: 'agent', agent_id: 'alpha' } } };
  const app = application(stored);
  await upsertProjectAgent(app, input({ judgment: 'Verify every change first, always.', taste: '', personality: '' }, PERSON_WRITER));
  assert.equal(app.writes[0].profile.character_authors.judgment.kind, 'both');
  const after = application({ character: app.writes[0].profile.character, character_authors: app.writes[0].profile.character_authors });
  const record = await upsertProjectAgent(after, input({ judgment: 'Replaced.', taste: '', personality: '' }, { kind: 'agent' }));
  assert.equal(after.writes[0].profile.character.judgment, 'Verify every change first, always.');
  assert.equal(record.refusedFields[0].field, 'judgment');
});

test('an entry with no writer writes as AI, and a save without preferences reads nothing', async () => {
  const app = application(null);
  await upsertProjectAgent(app, input({ judgment: 'Drafted at recruitment.', taste: '', personality: '' }));
  assert.equal(app.writes[0].profile.character_authors.judgment.kind, 'agent');
  const plain = application(null);
  await upsertProjectAgent(plain, { personalSpaceId: 'space-a', agentId: 'alpha', profile: { name: 'Aster', responsibility: 'Synthetic role' } });
  assert.equal('character_authors' in plain.writes[0].profile, false);
});
