import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeCodeNativeSessionId } from '../src/agents/claude-code/native-session.js';
import { nativeSessionFromEnv } from '../src/agents/native-session-env.js';
import { prepareDirectAgentToolCall } from '../src/mcp/direct-call.js';

const SESSION = '31a4b273-de3a-4d9b-b143-0202e6ce1ac6';
const TOKEN = 'fuli-task-11111111-2222-3333-4444-555555555555';

test('Claude Code session identity comes only from its own UUID environment value', () => {
  assert.equal(claudeCodeNativeSessionId({ CLAUDE_CODE_SESSION_ID: SESSION }), SESSION);
  for (const value of [undefined, '', 'my-session', `${SESSION}x`]) {
    assert.equal(claudeCodeNativeSessionId({ CLAUDE_CODE_SESSION_ID: value }), null);
  }
  // Read only for the client this process was started for.
  assert.equal(nativeSessionFromEnv('claude_code', { CLAUDE_CODE_SESSION_ID: SESSION }), SESSION);
  assert.equal(nativeSessionFromEnv('other', { CLAUDE_CODE_SESSION_ID: SESSION }), null);
  assert.equal(nativeSessionFromEnv('codex', { CLAUDE_CODE_SESSION_ID: SESSION }), null);
});

test('a Claude Code MCP process can recover its own task preferences, never a forged session', async () => {
  const call = (env, input = {}) => prepareDirectAgentToolCall({ toolName: 'read_task_preferences',
    input: { taskContextToken: TOKEN, ...input }, sourceApplication: 'claude_code', env });
  const own = await call({ CLAUDE_CODE_SESSION_ID: SESSION });
  assert.equal(own.input.sourceSessionId, SESSION);
  assert.equal(own.input.sourceSessionVerified, true);
  // Without host provenance the process has only its own random host ID.
  const unknown = await call({});
  assert.match(unknown.input.sourceSessionId, /^fuli-host-/);
  assert.equal(unknown.input.sourceSessionVerified, false);
  // The tool schema rejects caller-supplied session fields outright.
  await assert.rejects(call({}, { sourceSessionId: SESSION, sourceSessionVerified: true }), /Input validation/);
});

test('fallback task entry in Claude Code binds to the host session, not a model-supplied one', async () => {
  const { input } = await prepareDirectAgentToolCall({ toolName: 'get_collaboration_preferences',
    input: { projectPath: '/synthetic/project', taskPrompt: 'Synthetic task', sessionId: 'model-guess' },
    sourceApplication: 'claude_code', env: { CLAUDE_CODE_SESSION_ID: SESSION } });
  assert.equal(input.sessionId, SESSION);
});
