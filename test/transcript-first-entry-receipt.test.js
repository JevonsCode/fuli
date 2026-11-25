import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { transcriptLifecycle } from '../src/conversations/transcript-lifecycle.js';

for (const outcome of ['bound', 'different-task', 'no-receipt']) {
  test('first slow begin reports the exact durable native boundary: ' + outcome, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'fuli-first-boundary-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let entered = false, boundaries = 0;
    const current = { token: outcome === 'different-task' ? 'other' : 'initial-token',
      personal_project_id: 'one', project_agent_id: 'sample' };
    const app = { config: { personal: { spaceId: 'space' } }, getCapturePolicy: () => ({ enabled: true }),
      getCapturePolicyVersion: () => 'sample', personal: {
        currentTaskContext: async () => entered ? current : null,
        conversation: async (action, input) => {
          if (action === 'query') return input.mode === 'policy' ? { enabled: true } : { initialized: false };
          assert.equal(action, 'boundary');
          boundaries++;
          assert.equal(input.task_context_token, 'initial-token');
          return { status: outcome, cursor: input.cursor };
        } } };
    const unsaved = { status: 'unsaved', step: 'begin', reason: 'transcript_capture_timeout', retryable: true };
    const result = await transcriptLifecycle({ application: app, runtimeConfigPath: join(dir, 'runtime.json'), event: 'UserPromptSubmit',
      sourceApplication: 'codex', input: { session_id: 'fixture', cwd: dir, prompt: 'hello', transcript_path: join(dir, 'new.jsonl') },
      adapter: {}, run: async bind => { entered = true; return bind({ taskContextToken: 'initial-token', conversation: unsaved }); } });
    assert.equal(result.conversation.status, outcome === 'bound' ? 'deferred' : 'unsaved');
    assert.equal(boundaries, outcome === 'different-task' ? 0 : 1);
  });
}
