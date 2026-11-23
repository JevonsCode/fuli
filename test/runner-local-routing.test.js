import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createDeviceCertificate, deviceIdentity } from '../packages/roundtable/src/peer/device-identity.js';
import { createJudgmentService } from '../src/judgment/service.js';
import { JudgmentStore } from '../src/judgment/store.js';
import { startRunnerListener } from '../src/runner/host-listener.js';
import { createRunnerRoutes } from '../src/runner/host-routes.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { joinHost } from '../src/runner/join.js';
import { deliverOutbox } from '../src/runner/outbox-delivery.js';
import { encodeInvitation, newInvitationCode, RUNNER_PATHS } from '../src/runner/protocol.js';
import { runRunnerMcp } from '../src/runner/runner-mcp.js';

// Tonborg's executor judgment on a runner (docs/runner.md, "Executor judgment
// on a runner"): its own model, over its own executors, with or without the
// host; each decision and outcome reaches the host's Tonborg ledger once.
// The host is a real runner listener whose judgment service keeps an
// in-memory ledger; the runner's model is a loopback OpenAI-compatible server.
const SPACE = 'space-1';
const PROJECT = 'demo-project';
const ASK = { personalSpaceId: SPACE, personalProjectId: PROJECT, requestId: 'job-1', agentId: 'agent-1',
  workKind: 'implementation', objective: 'Change one card template', requiredCapabilities: ['coding'] };
const CHOICE = { disposition: 'delegate', conversationId: null, executorId: 'runner-node', model: 'flash-small',
  summary: 'A bounded edit: the cheap model is enough.', evidence: ['one template file'] };

test('with the host away, the runner\'s own Tonborg chooses among this computer\'s executors and queues the decision', async (t) => {
  const runner = await routingRunner(t);
  await runner.client.callTool({ name: 'get_collaboration_preferences', arguments: { projectPath: runner.projectPath, taskPrompt: 'first' } });
  runner.hostAway();

  const answer = await runner.client.callTool({ name: 'fuli_call', arguments: { toolName: 'assess_agent_action',
    input: { ...ASK, taskContextToken: 'runner-offline-x' } } });

  assert.equal(answer.isError, undefined, answer.content[0].text);
  const decision = answer.structuredContent;
  assert.equal(decision.decidedOn, 'runner');
  assert.deepEqual(decision.selection, { executorId: 'runner-node', model: 'flash-small', client: 'other' });
  assert.deepEqual(decision.leftOut, [{ executorId: 'nowhere', reason: 'command_not_found' }]);
  assert.equal(decision.model, 'fake-flash');
  assert.equal(runner.calls.some(({ name }) => name === 'assess_agent_action'), false, 'the host was never asked');

  const sent = JSON.stringify(runner.model.requests[0]);
  assert.match(sent, /short answers/, 'the preferences the host last gave the project went with it');
  assert.match(sent, /runner-node/);
  assert.doesNotMatch(sent, /runner-offline-x/, 'no task token leaves the runner');
  assert.equal(runner.served.store.outbox().queued, 1);

  const again = await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  assert.equal(again.structuredContent.id, decision.id, 'the same request gets the same decision');
  assert.equal(runner.model.requests.length, 1);
  assert.equal(runner.served.store.outbox().queued, 1);
});

test('once the host answers, the runner\'s decision and its outcome reach Tonborg\'s ledger once', async (t) => {
  const runner = await routingRunner(t);
  runner.hostAway();
  const decision = (await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK })).structuredContent;
  const report = { decisionId: decision.id, vote: 'up', reason: 'Tests passed on the first run.' };
  const reported = await runner.client.callTool({ name: 'report_routing_outcome', arguments: report });
  assert.equal(reported.structuredContent.status, 'queued');
  const twice = await runner.client.callTool({ name: 'report_routing_outcome', arguments: { ...report, vote: 'down' } });
  assert.equal(JSON.parse(twice.content[0].text).code, 'already_reported');

  runner.hostBack();
  // A delivery the runner began while the host was away may still hold the oldest entry; it waits its turn.
  for (const deadline = Date.now() + 20_000; runner.served.store.outbox().queued && Date.now() < deadline;) {
    await deliverOutbox({ store: runner.served.store, connection: runner.served.connection });
    await delay(100);
  }
  assert.deepEqual(runner.served.store.outbox(), { queued: 0, failedCount: 0, failed: [], entries: [] });

  const [record] = runner.judgment.store().records(SPACE, { personalProjectId: PROJECT });
  assert.equal(record.kind, 'routing');
  assert.equal(record.runnerDecisionId, decision.id);
  assert.equal(record.runner.name, 'Runner B');
  assert.deepEqual(record.selection, decision.selection);
  assert.equal(record.feedbackHistory.length, 1);
  assert.equal(record.feedback.vote, 'up');
  assert.match(record.feedback.reportedBy, /^runner:/);
  assert.equal(record.feedback.decidedBy, undefined, 'a runner\'s report is not the person\'s vote');

  // The same outcome delivered again (its answer was lost on the way) is applied once.
  const replayed = await runner.served.connection.postJson(RUNNER_PATHS.replay, { id: reported.structuredContent.outboxId,
    tool: 'runner_routing_outcome', input: { personalSpaceId: SPACE, ...report }, sourceApplication: 'codex', sessionId: null });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.replayedBefore, true);
  assert.equal(runner.judgment.store().records(SPACE, { personalProjectId: PROJECT })[0].feedbackHistory.length, 1);

  // The next judgment here reads how the earlier choice did.
  await runner.client.callTool({ name: 'assess_agent_action', arguments: { ...ASK, requestId: 'job-2' } });
  assert.match(JSON.stringify(runner.model.requests.at(-1)), /Tests passed on the first run/);
});

test('a runner model allowed more than executor routing is refused here; without one the host judges as before', async (t) => {
  const runner = await routingRunner(t, { operations: ['executor_routing', 'knowledge_review'] });
  const refused = await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  assert.equal(JSON.parse(refused.content[0].text).code, 'runner_routing_config_invalid');
  assert.equal(runner.model.requests.length, 0);
  assert.equal(runner.calls.length, 0);

  rmSync(path.join(runner.dataDir, 'model-backends.json'));
  const listed = await runner.client.listTools();
  assert.equal(listed.tools.some((tool) => tool.name === 'report_routing_outcome'), false);
  await runner.client.callTool({ name: 'assess_agent_action', arguments: ASK });
  assert.deepEqual(runner.calls.map(({ name }) => name), ['assess_agent_action']);
});

// A paired runner whose model-backends.json lets its Tonborg choose executors
// (operations) and whose executors.json declares one executor it can start and one it cannot.
async function routingRunner(t, { operations = ['executor_routing'] } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'fuli-runner-routing-')));
  const model = await fakeModel();
  const host = deviceIdentity(await createDeviceCertificate());
  const store = new RunnerHostStore(':memory:');
  const calls = [];
  const judgment = createJudgmentService({ app: { config: { personal: { spaceId: SPACE } } }, openStore: () => new JudgmentStore() });
  const routes = createRunnerRoutes({ app: { judgment }, store, hostName: 'Host A', hostFingerprint: host.fingerprint,
    withLease: (_owner, operation) => operation(),
    createMcp: () => {
      const server = new Server({ name: 'fuli', version: 'test' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['get_collaboration_preferences', 'assess_agent_action']
        .map((name) => ({ name, inputSchema: { type: 'object' } })) }));
      server.setRequestHandler(CallToolRequestSchema, (request) => {
        calls.push({ name: request.params.name, input: request.params.arguments });
        const value = request.params.name === 'get_collaboration_preferences'
          ? { effective_preferences: ['short answers'], taskContextToken: 'host-token-1',
            context: { personal_space_id: SPACE, personal_project_id: PROJECT } }
          : { outcome: 'recommend', decidedOn: 'host' };
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      });
      return server;
    } });
  const state = { away: false };
  const listener = await startRunnerListener({ identity: host, addresses: ['127.0.0.1'], port: 0, sourceAllowed: () => true,
    route: (request, response, context) => {
      if (!state.away) return routes.handle(request, response, context);
      request.socket.destroy();
      return true;
    } });
  const code = newInvitationCode();
  store.invite({ code, name: 'Runner B' });
  const dataDir = path.join(base, 'runner-data');
  await joinHost({ dataDir, invitation: encodeInvitation({ name: 'Host A', addresses: ['127.0.0.1'], port: listener.port,
    certPem: host.certPem, code }) });
  writeFileSync(path.join(dataDir, 'model-backends.json'), JSON.stringify({ version: 1,
    connections: { flash: { protocol: 'openai_chat', endpoint: `${model.origin}/v1`, model: 'fake-flash' } },
    roles: { tonborg: { enabled: true, connection: 'flash', allowedOperations: operations, budget: {} } } }));
  writeFileSync(path.join(dataDir, 'runner', 'executors.json'), JSON.stringify({ version: 1, executors: [
    { executorId: 'runner-node', displayName: 'Node here', client: 'other', command: 'node', capabilities: ['coding'],
      models: [{ model: 'flash-small', costRank: 1 }, { model: 'deep-large', costRank: 5 }] },
    { executorId: 'nowhere', displayName: 'Not installed', client: 'other', command: 'fuli-test-no-such-command',
      capabilities: ['coding'], models: [{ model: 'any' }] }] }));
  const projectPath = path.join(base, 'demo-project');
  mkdirSync(projectPath);

  const client = new Client({ name: 'codex', version: 'test' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = await runRunnerMcp({ dataDir, sourceApplication: 'codex', transport: serverSide,
    lookUp: async () => [], retryAfterMs: 0 });
  await client.connect(clientSide);
  // In this order, the folder last: Windows refuses to delete a SQLite file that is still open.
  t.after(async () => {
    await client.close();
    await served.close();
    await listener.close();
    await routes.close();
    store.close();
    judgment.close();
    await model.close();
    rmSync(base, { recursive: true, force: true });
  });
  return { client, served, calls, model, judgment, dataDir, projectPath,
    hostAway: () => { state.away = true; }, hostBack: () => { state.away = false; } };
}

// An OpenAI-compatible endpoint on loopback that always makes CHOICE, keeping each request it got.
async function fakeModel() {
  const requests = [];
  const server = createServer((request, response) => {
    // FULI asks a loopback model for its Ollama build; this one is none.
    if (request.method !== 'POST') return void response.writeHead(404).end();
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(body));
      const content = JSON.stringify({ decision: 'propose', payload: CHOICE, reason: 'bounded edit', evidenceIds: ['eligible'],
        uncertainty: null });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'fake-flash', choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 900, completion_tokens: 60 } }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { requests, origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)) };
}
