import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateClaudeSession } from '../../../src/agents/claude-code/session-file.js';
import { createSessionPreferenceDelivery } from '../../../src/conversations/preference-session.js';
import { withPreferenceScope } from '../../../src/conversations/preference-snapshot.js';
import { preferenceHookOutput } from '../../../src/conversations/preference-lifecycle.js';
import { createMcpServer } from '../../../src/mcp/create-mcp-server.js';
import { syntheticHost, syntheticJournal } from '../../../test-support/synthetic-context-session.js';

for (const requestContext of [true, false]) test(`Claude default discovery and chat dispatcher reuse history (native metadata: ${requestContext})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'fuli-claude-evidence-'));
  const session = randomUUID(), project = join(root, 'projects', 'synthetic-project');
  await mkdir(project, { recursive: true });
  const host = syntheticHost(project, 'claude_code', session, { fileName: `${session}.jsonl` });
  const env = { CLAUDE_CONFIG_DIR: root, CLAUDE_CODE_SESSION_ID: session };
  const delivery = createSessionPreferenceDelivery({ directory: join(root, 'cache'), env });
  const journal = syntheticJournal('synthetic-conversation');
  journal.add('user', 'synthetic raw history', 'codex', 'other-session', 'other-event');
  const entry = () => withPreferenceScope({ taskContextToken: 'synthetic-task', effective_preferences: [],
    conversation: { recovery: journal.recovery('claude_code', session) } }, {
    personal_space_id: 'space', personal_project_id: 'project', project_agent_id: 'lead', session_id: session,
    source_application: 'claude_code', preference_scope: { version: 1, work_kind: null, workflow: null }
  });
  const page = { id: 'synthetic-conversation', events: [{ sequence: 1, kind: 'message', role: 'user', content: 'synthetic raw history' }] };
  const server = createMcpServer({ preferenceDelivery: delivery, queryAgentConversations: async () => page,
    getCollaborationPreferences: async () => entry() }, { env, sourceApplication: 'claude_code', toolProfile: 'chat', registerResources: false,
    ...(requestContext ? { nativeRequestContext: () => ({ nativeSessionId: session, nativeExecutionId: 'synthetic', contextWindowId: 'window' }) } : {}) });
  const call = arguments_ => server.server._requestHandlers.get('tools/call')({ method: 'tools/call',
    params: { name: 'fuli_call', arguments: arguments_ } }, { signal: new AbortController().signal, requestId: 1 });
  try {
    await host.start();
    assert.equal(await locateClaudeSession(session, join(root, 'projects')), host.path);
    const input = { toolName: 'read_agent_conversation', input: { personalSpaceId: 'space', agentId: 'lead', conversationId: page.id } };
    const result = await call(input);
    assert.notEqual(result.isError, true);
    await host.toolResult('read', result.structuredContent, JSON.parse(result.content[0].text), 'mcp__fuli__fuli_call', input);
    // The first preference request in this same MCP process must not reset away
    // the pending history result recorded immediately before it.
    const preferences = await call({ toolName: 'get_collaboration_preferences', input: { projectPath: root } });
    assert.deepEqual(preferences.structuredContent.conversation.recovery.messages?.map(message => message.content) ?? [],
      requestContext ? [] : ['synthetic raw history'], 'unknown MCP window still receives full preferences and history');
    const hook = await preferenceHookOutput(entry(), 'UserPromptSubmit', { session_id: session, transcript_path: host.path },
      delivery, 'claude_code', 'Synthetic context');
    assert.equal(JSON.parse(hook.hookSpecificOutput.additionalContext.split('\n').at(-1)).conversation.recovery.messages_omitted, 1);
    const duplicate = join(root, 'projects', 'duplicate');
    await mkdir(duplicate);
    await writeFile(join(duplicate, `${session}.jsonl`), '{}\n');
    assert.equal(await locateClaudeSession(session, join(root, 'projects')), null);
    assert.equal(await locateClaudeSession('../invalid', join(root, 'projects')), null);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
