import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { recordHookFailure } from '../src/agents/lifecycle-failure.js';
import { validationError } from '../src/app/application-error.js';

// rec#85: a failed hook's diagnostic event says which rule refused it.
test('a failed hook records the controlled reason, never an uncontrolled message', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-hook-reason-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const runtimeConfigPath = join(dataDir, 'runtime.json');
  recordHookFailure({ runtimeConfigPath, client: 'codex', event: 'UserPromptSubmit',
    error: validationError('Task preference scope is immutable; begin a new task for different dimensions') });
  recordHookFailure({ runtimeConfigPath, client: 'codex', event: 'UserPromptSubmit',
    error: new TypeError('synthetic prompt text that must stay out') });
  const events = readFileSync(join(dataDir, 'diagnostics', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events[0].code, 'validation');
  assert.match(events[0].reason, /preference scope is immutable/);
  assert.match(events[1].reason, /^the hook failed: TypeError in FULI /);
  assert.doesNotMatch(JSON.stringify(events), /synthetic prompt text/);
});
