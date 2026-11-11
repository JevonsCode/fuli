import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { packManifestClient } from '../src/agent-kits/pack-manifest.js';
import { builtInClientPack } from '../test-support/client-packs.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

// The Skills FULI's installer manifest gives a descriptor pack client.
function manifestSkills(id) {
  return packManifestClient(builtInClientPack(id)).skills.map(({ name, source }) => [name, source]);
}

// 11-11: the /flreview knowledge review was retired; no client is given its Skill or a command for it.
test('no client is given the retired flreview Skill or a review command', () => {
  for (const id of ['codex', 'claude-code', 'cursor', 'opencode']) {
    assert.equal(manifestSkills(id).some(([name]) => name === 'flreview'), false, id);
    assert.equal(builtInClientPack(id).commandSkills.review, undefined, id);
  }
});

// rec#5 C3b: /fuli start|stop|restart|status is a native command where the client turns
// a Skill into one; the prompt hook answers the line, so the Skill never runs on its own.
test('the FULI session command Skill is installed only where a client takes it as /fuli', () => {
  const hasFuli = id => manifestSkills(id).some(([name]) => name === 'fuli');
  assert.equal(hasFuli('claude-code'), true);
  assert.equal(hasFuli('cursor'), true);
  assert.equal(hasFuli('codex'), false, 'Codex rejects user-defined slash commands; the person types `fuli stop` there');
  assert.equal(hasFuli('opencode'), false);

  const skill = readFileSync(join(PROJECT_ROOT, 'skills', 'fuli', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: fuli\ndescription: .+\ndisable-model-invocation: true\nargument-hint: start\|stop\|restart\|status\n---\n/);
  assert.match(skill, /do not say FULI was started or stopped/);
  assert.doesNotMatch(skill, /Codex|Claude|Cursor/, 'no client branching in the shared Skill');
});
