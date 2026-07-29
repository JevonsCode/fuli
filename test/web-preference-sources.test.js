import assert from 'node:assert/strict';
import test from 'node:test';

import { detectPreferenceConflicts } from '../web/js/preference-conflicts.js';
import {
  copySourceSession,
  sourceApplicationLabel,
  sourceLinkForEvidence
} from '../web/js/source-adapters.js';

test('Codex evidence opens the exact source task while other agents use a copy fallback', async () => {
  const codex = {
    source_application: 'codex',
    session_id: '019f6118-f787-7ef3-91a7-9e5cc6e85b45'
  };
  const cursor = { source_kind: 'Cursor conversation', session_id: 'cursor-session-7' };
  let copied = null;

  assert.equal(
    sourceLinkForEvidence(codex),
    'codex://threads/019f6118-f787-7ef3-91a7-9e5cc6e85b45'
  );
  assert.equal(sourceApplicationLabel(cursor), 'Cursor');
  assert.equal(sourceLinkForEvidence(cursor), null);
  assert.equal(await copySourceSession(cursor, {
    async writeText(value) { copied = value; }
  }), true);
  assert.equal(copied, 'cursor-session-7');
});

test('suspected preference conflicts require an overlapping scope and the same preference key', () => {
  const global = preference('global', 'light', 'global', null);
  const projectException = preference('project-a-dark', 'dark', 'project', 'project-a');
  const otherProject = preference('project-b-dark', 'dark', 'project', 'project-b');

  const conflicts = detectPreferenceConflicts([global, projectException]);

  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].projectId, 'project-a');
  assert.match(conflicts[0].reason, /有意例外/);
  assert.equal(detectPreferenceConflicts([projectException, otherProject]).length, 0);
});

function preference(id, value, scope, projectId) {
  return {
    id,
    title: '界面主题',
    body: value,
    profileAspect: 'taste',
    preferenceScope: scope,
    preferenceProjectId: projectId,
    raw: {
      attributes: { preferenceKey: 'ui-theme', preferenceValue: value }
    }
  };
}
