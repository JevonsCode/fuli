import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';

// rec#81: a claim came back cut at 1200 bytes, without its schema or lease, so
// the session could not submit it. Synthetic package only.
const claimed = { workPackage: { packageId: 'package-a', role: 'tonborg', status: 'claimed', instructions: 'Decide. '.repeat(600),
  answerSchema: { type: 'object', required: ['disposition'] }, lease: { token: 'lease-a', expiresAt: '2026-11-04T12:00:00.000Z' } } };

async function connected(t, app, toolNames) {
  const server = createMcpServer(app, { sourceApplication: 'codex', toolNames });
  const client = new Client({ name: 'synthetic', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  t.after(() => client.close());
  return client;
}

test('a claimed work package arrives whole, with its schema and lease', async (t) => {
  const client = await connected(t, { roleWork: { claim: async () => claimed, submit: async () => ({}) } }, ['role_work']);
  const result = await client.callTool({ name: 'role_work', arguments: { action: 'claim', taskContextToken: 'token-a' } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent.truncated, undefined);
  assert.deepEqual(result.structuredContent, claimed);
});

test('a work package too large to deliver whole says so instead of arriving cut', async (t) => {
  const huge = { workPackage: { ...claimed.workPackage, instructions: 'x'.repeat(300 * 1024) } };
  const client = await connected(t, { roleWork: { claim: async () => huge, submit: async () => ({}) } }, ['role_work']);
  const result = await client.callTool({ name: 'role_work', arguments: { action: 'claim', taskContextToken: 'token-a' } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /result_too_large/);
});
