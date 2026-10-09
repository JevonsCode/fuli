import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { callAgentTool } from '../src/agent-tools.js';
import { createFuliRoundtableService } from '../src/roundtables/application.js';
import { createRoundtableService } from '../src/roundtables/service.js';
import { createRoundtableServer } from '../src/roundtables/server.js';
import { ROUNDTABLE_TOOL_NAMES } from '../src/roundtables/tool-contract.js';

const owner = { kind: 'owner' };
const roomInput = { goal: 'Protect private context', limits: { maxRounds: 1 }, seats: [
  { id: 'a', name: 'A', role: 'moderator' }, { id: 'b', name: 'B', role: 'specialist' }] };

test('Fuli app validates exact projects/agents; no unused collaboration database opens', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-roundtable-app-'));
  const app = { config: { personal: { spaceId: 'space' } },
    listPersonalProjects: async () => [{ project_id: 'project' }],
    getProjectAgent: async ({ agentId }) => { assert.equal(agentId, 'agent-a'); return { profile: { status: 'active', allowedClients: ['codex'] } }; },
    getProjectAgentContext: async () => ({ private: 'own-context-only' }) };
  const service = createFuliRoundtableService({ app, dataDir: dir });
  t.after(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(existsSync(join(dir, 'roundtables.sqlite')), false);
  await assert.rejects(service.create({ ...roomInput, personalProjectId: 'unknown' }, owner), /not found/);
  assert.equal(existsSync(join(dir, 'roundtables.sqlite')), false);
  const snapshot = await service.create({ ...roomInput, personalProjectId: 'project', seats: [
    { ...roomInput.seats[0], agentId: 'agent-a', shareAgentContext: true }, roomInput.seats[1]] }, owner);
  const roomId = snapshot.room.id;
  const actors = [];
  for (const seat of snapshot.room.seats) {
    const invitation = service.invite({ roomId, seatId: seat.id }, owner);
    const actor = service.authenticate({ roomId, seatToken: invitation.seatToken, sourceApplication: 'codex', sourceSessionId: `native-${seat.id}` });
    actors.push(actor); service.join({ roomId }, actor);
  }
  service.control({ roomId, action: 'start' }, owner);
  const claim = await service.claim({ roomId }, actors[0]);
  assert.equal(claim.context.privateAgentContext.private, 'own-context-only');
  assert.ok(!JSON.stringify(service.read({ roomId }, actors[1])).includes('own-context-only'));
});

test('normal Fuli MCP supplies trusted host session and direct capability calls remain usable', async (t) => {
  const service = createRoundtableService();
  t.after(() => service.close());
  const room = service.create(roomInput, owner).room;
  const { seatToken } = service.invite({ roomId: room.id, seatId: 'a' }, owner);
  const app = { roundtables: service, getAgentAccessPolicy: () => ({ enabled: true }) };
  const direct = await callAgentTool(app, 'read_roundtable', { roomId: room.id, seatToken });
  assert.equal(direct.room.id, room.id);
  const server = createMcpServer(app, { env: {}, sourceApplication: 'codex', hostSessionId: 'trusted-host',
    toolNames: ROUNDTABLE_TOOL_NAMES, registerResources: false });
  const client = new Client({ name: 'native-codex-client', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: 'join_roundtable', arguments: { roomId: room.id, seatToken } });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.throws(() => callAgentTool({ ...app, getAgentAccessPolicy: () => ({ enabled: false }) }, 'read_roundtable', { roomId: room.id, seatToken }), { code: 'agent_access_disabled' });
});

test('standalone network creation rejects forged Fuli binding and ignored projectPath', async (t) => {
  const service = createRoundtableService();
  const host = await createRoundtableServer({ service, port: 0 });
  t.after(async () => { await host.close(); service.close(); });
  for (const extra of [{ binding: { personalSpaceId: 'fake', personalProjectId: 'fake' } }, { projectPath: '/fake' }]) {
    const response = await fetch(`${host.url}/api/roundtables`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...roomInput, ...extra }) });
    assert.equal(response.status, 400); assert.equal(service.list({}, owner).rooms.length, 0);
  }
});
