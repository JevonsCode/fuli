import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRoundtableService } from '../src/roundtables/service.js';
import { createRoundtableServer } from '../src/roundtables/server.js';

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
  assert.deepEqual(tools.tools.map(({ name }) => name).sort(), ['claim_roundtable_turn', 'join_roundtable', 'read_roundtable', 'submit_roundtable_turn']);
  const call = async (client, name, args = {}) => {
    const result = await client.callTool({ name, arguments: { ...args, roomId: room.id } });
    assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text);
  };
  for (const client of clients) await call(client, 'join_roundtable');
  service.control({ roomId: room.id, action: 'start' }, owner);
  const a = await call(clients[0], 'claim_roundtable_turn');
  await call(clients[0], 'submit_roundtable_turn', { turnId: a.turnId, attemptId: a.attemptId, fence: a.fence, body: 'mcp-random-evidence', idempotencyKey: a.attemptId });
  const b = await call(clients[1], 'claim_roundtable_turn');
  assert.ok(JSON.stringify(b.context).includes('mcp-random-evidence'));
  const wrongRoom = await clients[1].callTool({ name: 'read_roundtable', arguments: { roomId: 'wrong' } });
  assert.equal(wrongRoom.isError, true);
});
