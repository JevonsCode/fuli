import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRoundtableService } from '../src/roundtables/service.js';
import { createRoundtableServer } from '../src/roundtables/server.js';
import { ROUNDTABLE_TOOL_DEFINITIONS } from '../src/roundtables/tool-contract.js';

test('two real MCP SDK sessions share only invited room; no create/invite/shell tools', async (t) => {
  const service = createRoundtableService();
  const host = await createRoundtableServer({ service, port: 0 });
  t.after(async () => { await host.close(); service.close(); });
  const owner = { kind: 'owner' };
  const room = service.create({ goal: 'MCP seat exchange', limits: { maxRounds: 1 }, seats: [
    { id: 'a', name: 'A', role: 'moderator' }, { id: 'b', name: 'B', role: 'specialist' }] }, owner).room;
  const clients = [];
  for (const id of ['a', 'b']) {
    const { seatToken } = service.invite({ roomId: room.id, seatId: id }, owner);
    const client = new Client({ name: `independent-${id}`, version: '1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${host.url}/roundtable-peer/v1/rooms/${room.id}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${seatToken}` } } });
    await client.connect(transport); clients.push(client); t.after(() => client.close());
  }
  const tools = await clients[0].listTools();
  assert.deepEqual(tools.tools.map(({ name }) => name).sort(), ['claim_roundtable_turn', 'discover_roundtable', 'join_roundtable', 'message_roundtable', 'read_roundtable', 'submit_roundtable_turn']);
  for (const definition of ROUNDTABLE_TOOL_DEFINITIONS) {
    const required = definition.inputSchema.required;
    assert.equal(new Set(required).size, required.length);
    assert.ok(required.includes('roomId'));
    assert.ok(required.includes('seatToken'));
  }
  for (const definition of tools.tools) {
    assert.equal(definition.inputSchema.properties.roomId, undefined);
    assert.equal(definition.inputSchema.properties.seatToken, undefined);
    assert.notEqual(definition.inputSchema.required?.includes('roomId'), true);
    assert.notEqual(definition.inputSchema.required?.includes('seatToken'), true);
  }
  const call = async (client, name, args = {}, includeRoomId = true) => {
    const result = await client.callTool({ name, arguments: { ...args, ...(includeRoomId ? { roomId: room.id } : {}) } });
    assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text);
  };
  const firstDiscovery = await call(clients[0], 'discover_roundtable', {}, false);
  assert.equal(firstDiscovery.nextAction.action, 'join');
  await call(clients[0], 'join_roundtable', { selfProfile: { responsibility: 'moderate', capabilities: ['planning'] } }, false);
  await call(clients[1], 'join_roundtable', { selfProfile: { responsibility: 'implement evidence', capabilities: ['testing'] } }, false);
  const peer = await call(clients[0], 'message_roundtable', { toSeatId: 'b', body: 'Please share test evidence', kind: 'question', idempotencyKey: 'mcp-peer-1' }, false);
  const peerRetry = await call(clients[0], 'message_roundtable', { toSeatId: 'b', body: 'Please share test evidence', kind: 'question', idempotencyKey: 'mcp-peer-1' }, false);
  assert.equal(peerRetry.message.id, peer.message.id);
  service.control({ roomId: room.id, action: 'start' }, owner);
  const a = await call(clients[0], 'claim_roundtable_turn', {}, false);
  await call(clients[0], 'submit_roundtable_turn', { turnId: a.turnId, attemptId: a.attemptId, fence: a.fence, body: 'mcp-random-evidence', idempotencyKey: a.attemptId }, false);
  const b = await call(clients[1], 'claim_roundtable_turn', {}, false);
  assert.ok(JSON.stringify(b.context).includes('mcp-random-evidence'));
  const wrongRoom = await clients[1].callTool({ name: 'read_roundtable', arguments: { roomId: 'wrong' } });
  assert.equal(wrongRoom.isError, true);
});
