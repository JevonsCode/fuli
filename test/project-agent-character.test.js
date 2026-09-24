import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectAgentRecord, projectAgentProfileRecord, projectAgentRecruitmentRecord,
  providerProjectAgentProfile, providerProjectAgentTaskSubmit
} from '../src/graphiti/project-agent-mapping.js';
import { projectAgentProfile, projectAgentTaskSubmitInput } from '../src/agent-tools/project-agent-definitions.js';

const character = { judgment: 'Verify evidence.', taste: 'Prefer clear layouts.', personality: 'Patient and direct.' };
const expectations = 'Explain tradeoffs.';

test('profile traits round trip without dropping existing execution settings', () => {
  const profile = {
    name: 'Synthetic reviewer', responsibility: 'Review changes.', character, expectations,
    capabilities: ['review'], initialPreferences: ['Be concise.'],
    displayName: 'Synthetic role', occupationEmoji: '🔎', agentType: 'durable',
    workKinds: ['review'], allowedClients: ['codex'], status: 'active',
    testSource: 'synthetic_fixture', cleanupEligible: true,
    defaultModelStrategy: { mode: 'deep', reasoningEffort: 'high', capabilityHints: [] },
    executorPolicy: { mode: 'locked', lockedExecutorIds: ['synthetic-executor'], preferredExecutorIds: [] }
  };
  const stored = providerProjectAgentProfile(profile);
  assert.deepEqual(stored.character, character);
  assert.equal(stored.expectations, expectations);
  assert.deepEqual(projectAgentRecord({ profile: stored }).profile, profile);
  assert.deepEqual(providerProjectAgentProfile(projectAgentProfileRecord(stored)), stored);
  assert.deepEqual(providerProjectAgentProfile(stored), stored);
});

test('HR recruitment submit and proposed profile preserve configured traits', () => {
  const profile = { name: 'Synthetic reviewer', responsibility: 'Review changes.', character, expectations };
  for (const field of ['recruitmentProfile', 'recruitment_profile']) {
    const request = providerProjectAgentTaskSubmit({ [field]: profile });
    assert.deepEqual(request.recruitment_profile.character, character);
    assert.equal(request.recruitment_profile.expectations, expectations);
    const record = projectAgentRecruitmentRecord({ proposed_profile: request.recruitment_profile });
    assert.deepEqual(record.proposedProfile.character, character);
    assert.equal(record.proposedProfile.expectations, expectations);
  }
});

test('MCP exposes optional bounded character and expectations for profiles and HR', () => {
  const fields = projectAgentProfile.properties;
  assert.equal(fields.expectations.maxLength, 4096);
  for (const field of ['judgment', 'taste', 'personality']) {
    assert.equal(fields.character.properties[field].maxLength, 2048);
    assert.equal(fields.character.properties[field].minLength ?? 0, 0);
  }
  assert.equal(projectAgentProfile.required.includes('character'), false);
  assert.equal(projectAgentProfile.required.includes('expectations'), false);
  assert.deepEqual(projectAgentTaskSubmitInput.properties.recruitmentProfile.properties.character, fields.character);
});

test('older profiles can omit traits and explicit empty values survive mapping', () => {
  const legacy = { name: 'Synthetic reviewer', responsibility: 'Review changes.' };
  assert.equal(Object.hasOwn(providerProjectAgentProfile(legacy), 'character'), false);
  const cleared = { ...legacy, character: { judgment: '', taste: '', personality: '' }, expectations: '' };
  assert.deepEqual(projectAgentRecord({ profile: providerProjectAgentProfile(cleared) }).profile.character, cleared.character);
  assert.equal(projectAgentProfileRecord(providerProjectAgentProfile(cleared)).expectations, '');
});
