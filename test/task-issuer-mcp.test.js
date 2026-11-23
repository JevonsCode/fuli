import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer } from '../src/mcp/create-mcp-server.js';

// Review of #1075: a conversation begun on a computer that follows this one and continued here carries
// the token as the follower gave it, `fuli-from-<this FULI>.<token>` (src/runner/task-issuer.js).
async function serve(t, taskIssuer) {
  const seen = [];
  const app = { resumeAgentConversation: async (input) => { seen.push(input.taskContextToken); return { status: 'resumed' }; } };
  const server = createMcpServer(app, { env: {}, sourceApplication: 'codex', registerResources: false, taskIssuer });
  const client = new Client({ name: 'task-issuer-test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  t.after(async () => { await client.close(); await server.close(); });
  const resume = (token) => client.callTool({ name: 'resume_agent_conversation',
    arguments: { taskContextToken: token, conversationId: 'conversation-synthetic' } });
  return { seen, resume };
}

test('this FULI takes back a token that names it, and refuses one that names another FULI', async (t) => {
  const { seen, resume } = await serve(t, 'ab'.repeat(8));
  const own = await resume(`fuli-from-${'ab'.repeat(8)}.fuli-task-synthetic`);
  assert.equal(own.isError, undefined);
  assert.deepEqual(seen, ['fuli-task-synthetic'], 'the tool gets this FULI\'s own token');

  const other = await resume(`fuli-from-${'cd'.repeat(8)}.fuli-task-synthetic`);
  assert.equal(other.isError, true);
  assert.match(other.content[0].text, /task_issued_elsewhere/);
  assert.match(other.content[0].text, /issued by another FULI/);
  assert.deepEqual(seen, ['fuli-task-synthetic'], 'and nothing of another FULI\'s task runs here');

  await resume('fuli-task-plain');
  assert.deepEqual(seen, ['fuli-task-synthetic', 'fuli-task-plain'], 'a plain token is as before');
});

// Review of #1075: a FULI that cannot tell its own name must not say its own token is another FULI's.
test('a FULI that cannot tell its own name says so, never that the token is another FULI\'s', async (t) => {
  const { seen, resume } = await serve(t, null);
  const answer = await resume(`fuli-from-${'ab'.repeat(8)}.fuli-task-synthetic`);
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /task_issuer_unknown/);
  assert.match(answer.content[0].text, /cannot tell whether that is itself/);
  assert.doesNotMatch(answer.content[0].text, /another FULI/);
  assert.deepEqual(seen, []);
});
