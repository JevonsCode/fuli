import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { explicitlyContinuedInTurn } from '../../../src/agents/claude-code/turn-ownership.js';

// A turn belongs to a task once the model checkpoints with that task's token
// (turn-ownership.js). On a follower the hook gives the model the token with
// the name of the computer that issued it (src/runner/hook-scope.js), so the
// model's call names it so too. Synthetic transcript only.
const SESSION = 'synthetic-session';
const TOKEN = 'fuli-task-00000000-0000-4000-8000-000000000001';

function transcript(t, token, { isError = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'fuli-turn-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'session.jsonl');
  writeFileSync(file, [
    { type: 'assistant', sessionId: SESSION, message: { content: [{ type: 'tool_use', id: 'call-1',
      name: 'mcp__fuli__checkpoint_task_knowledge', input: { taskContextToken: token } }] } },
    { type: 'user', sessionId: SESSION, message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: isError }] } }
  ].map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

test('a checkpoint names the task with or without the computer that issued its token', (t) => {
  assert.equal(explicitlyContinuedInTurn(transcript(t, TOKEN), SESSION, TOKEN, 0), true);
  const named = `fuli-from-${'ab'.repeat(8)}.${TOKEN}`;
  assert.equal(explicitlyContinuedInTurn(transcript(t, named), SESSION, TOKEN, 0), true, 'named by the computer that issued it');
  assert.equal(explicitlyContinuedInTurn(transcript(t, TOKEN), SESSION, named, 0), true, 'and the other way round');
  assert.equal(explicitlyContinuedInTurn(transcript(t, `fuli-from-${'ab'.repeat(8)}.fuli-task-other`), SESSION, TOKEN, 0), false);
  assert.equal(explicitlyContinuedInTurn(transcript(t, named, { isError: true }), SESSION, TOKEN, 0), false, 'a failed call proves nothing');
});
