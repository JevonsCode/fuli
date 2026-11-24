// A Claude Code Stop keeps what the turn's runs verified, never the Agent's own
// reply (seen 2026-11-08: replies that cited a recalled item were kept as
// pending experiences, each one a link to the one before). Synthetic only: a
// temporary transcript and a recording invoke; no FULI data or client is used.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claudeLifecycleOutput } from '../../../src/agents/claude-code/lifecycle-event.js';

const SESSION = 'synthetic-stop-session';
const itemUrl = id => `http://127.0.0.1:2828/knowledge/project/space-1/directory/entity/${id}`;
const NESTED = `[\\[Only two clients open a new chat\\](${itemUrl('item-a')})](${itemUrl('item-b')})`;
// A reply that states a convention, cites a recalled item and ends with its receipt.
const REPLY = [`**[🌠 FULI · 知识增强](${itemUrl('item-b')})**`,
  `${NESTED} Error codes follow the TW-<AREA>-<NNN> convention: every code must be listed in docs/error-codes.md.`,
  'The fix is to run the fixtures first.',
  'FULI Agent：[Lyn](<fuli://agents/space-1/agent-1>)'].join('\n');
const line = value => JSON.stringify({ sessionId: SESSION, ...value });

test('Stop keeps the checks the turn ran clean and nothing of the reply', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-stop-reply-'));
  try {
    const transcript = join(root, 't.jsonl');
    writeFileSync(transcript, [
      line({ type: 'user', message: { content: 'Add the webhook error code and run the tests.' } }),
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'run-1', name: 'Bash', input: { command: 'npm test' } }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'run-1', content: '# pass 12', is_error: false }] } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: REPLY }] } })
    ].join('\n'));
    const calls = [];
    const invoke = async (name, input) => {
      calls.push({ name, input });
      return name === 'verify_task_checkpoint'
        ? { decision: 'block', reason: 'checkpoint', task_context_token: 'fuli-task-stop', entry_via: 'hook' } : {};
    };
    await claudeLifecycleOutput('Stop', { session_id: SESSION, hook_event_name: 'Stop', transcript_path: transcript,
      last_assistant_message: REPLY }, invoke);
    const checkpoint = calls.find(call => call.name === 'checkpoint_task_knowledge').input;
    assert.deepEqual(checkpoint.experiences.map(item => item.task), ['Project checks: `npm test`']);
    assert.doesNotMatch(JSON.stringify(checkpoint.experiences), /convention|fixtures|FULI|127\.0\.0\.1|fuli:/u);
    // The reply's citation still counts as use; it is not knowledge.
    assert.deepEqual(checkpoint.knowledgeUsage.map(use => use.itemId).sort(), ['item-a', 'item-b']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
