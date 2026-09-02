import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { callAgentTool } from '../src/agent-tools.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { createRemoteMcpHttpServer } from '../src/mcp/remote-http-server.js';
import { realTaskContextEnabled, realTaskContextProvider } from '../test-support/real-task-context-provider.js';

// Only the delivery of one real HTTP read is paused. Database and application logic are real.
for (const competingAction of ['complete', 'supersede']) {
  test(`stale preparation rejected after another request ${competingAction}s cannot mutate Agent memory`, {
    skip: !realTaskContextEnabled, timeout: 90_000
  }, async (t) => {
    const fixture = await realTaskContextProvider(t);
    const readReady = Promise.withResolvers();
    const releaseRead = Promise.withResolvers();
    let paused = false;
    const app = application(fixture.config, async (url, options) => {
      const response = await fetch(url, options);
      if (!paused && new URL(url).pathname === `/v1/task-contexts/${fixture.context.token}`
        && (!options?.method || options.method === 'GET')) {
        paused = true;
        // Materialize the real response before allowing the competing request to commit.
        const body = await response.text();
        readReady.resolve();
        await releaseRead.promise;
        return new Response(body, { status: response.status, headers: response.headers });
      }
      return response;
    });
    const losing = callAgentTool(app, 'checkpoint_task_knowledge', {
      taskContextToken: fixture.context.token, sourceApplication: 'codex',
      disposition: 'retain_nothing', reason: 'The stale request must not win.',
      agentMemory: { expectedRevision: 0, memory: { summary: 'Rejected stale memory.' } }
    });
    const rejected = assert.rejects(losing);
    try {
      await readReady.promise;
      if (competingAction === 'complete') {
        await callAgentTool(application(fixture.config), 'checkpoint_task_knowledge', {
          taskContextToken: fixture.context.token, sourceApplication: 'codex',
          disposition: 'retain_nothing', reason: 'The winning request records no memory change.'
        });
      } else {
        await fixture.request('/v1/task-contexts', { ...fixture.context,
          token: `fuli-task-${randomUUID()}`, turn_id: 'turn-two' }, 'PUT');
      }
    } finally { releaseRead.resolve(); }
    await rejected;
    const memory = await fixture.memory();
    assert.equal(memory.revision, 0, 'a rejected task checkpoint must have no memory side effect');
    assert.equal(memory.current, null);
  });
}

function application(config, fetchImpl = fetch) {
  return new FederatedGraphApplication(config, {
    fetchImpl, capturePolicyStore: { read: () => ({ enabled: true }) },
    agentAccessPolicyStore: { read: () => ({ enabled: true }) }
  });
}

test('a project-bound remote server cannot checkpoint another project token', {
  skip: !realTaskContextEnabled, timeout: 90_000
}, async (t) => {
  const fixture = await realTaskContextProvider(t);
  const projectB = 'synthetic-checkpoint-project-b';
  await fixture.request('/v1/personal-projects', {
    personal_space_id: fixture.context.personal_space_id,
    project_id: projectB,
    profile: { name: 'Synthetic checkpoint project B', lifecycle: 'active' }
  }, 'PUT');
  const app = application(fixture.config);
  const common = {
    app, host: '127.0.0.1', port: 0,
    personalSpaceId: fixture.context.personal_space_id,
    sourceApplication: 'claude'
  };
  const remoteA = await createRemoteMcpHttpServer({
    ...common, personalProjectId: fixture.context.personal_project_id,
    bearerToken: 'synthetic-project-a-token-1234567890'
  });
  const remoteB = await createRemoteMcpHttpServer({
    ...common, personalProjectId: projectB,
    bearerToken: 'synthetic-project-b-token-1234567890'
  });
  const remoteAPeer = await createRemoteMcpHttpServer({
    ...common, personalProjectId: fixture.context.personal_project_id,
    bearerToken: 'synthetic-project-a-peer-token-123456'
  });
  t.after(() => Promise.allSettled([
    remoteA.close(), remoteB.close(), remoteAPeer.close()
  ]));
  const connect = async (remote, token, name) => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${remote.url}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } }
    );
    const client = new Client({ name, version: '1.0.0' });
    await client.connect(transport);
    t.after(() => client.close());
    return client;
  };
  const clientA = await connect(
    remoteA, 'synthetic-project-a-token-1234567890', 'remote-project-a'
  );
  const clientB = await connect(
    remoteB, 'synthetic-project-b-token-1234567890', 'remote-project-b'
  );
  const clientAPeer = await connect(
    remoteAPeer, 'synthetic-project-a-peer-token-123456', 'remote-project-a-peer'
  );
  const started = await clientA.callTool({
    name: 'begin_task_context',
    arguments: {
      sessionId: 'remote', projectPath: '.',
      taskPrompt: 'Review the synthetic remote project boundary.'
    }
  });
  assert.equal(started.isError, undefined, JSON.stringify(started));
  const token = started.structuredContent.task_context_token;
  assert.equal(started.structuredContent.context.personal_project_id,
    fixture.context.personal_project_id);
  assert.equal(started.structuredContent.context.project_agent_id, 'engineer');
  await fixture.request('/v1/project-agents', {
    personal_space_id: fixture.context.personal_space_id,
    personal_project_id: fixture.context.personal_project_id,
    agent_id: 'reviewer',
    profile: {
      name: 'Synthetic reviewer', responsibility: 'Review the synthetic sample.',
      allowed_clients: ['claude'], work_kinds: ['review'], capabilities: ['review']
    }
  }, 'PUT');
  const crossRoleRead = await clientA.callTool({
    name: 'get_project_agent_memory',
    arguments: {
      personalSpaceId: fixture.context.personal_space_id,
      personalProjectId: fixture.context.personal_project_id,
      agentId: 'reviewer'
    }
  });
  assert.equal(crossRoleRead.isError, true, JSON.stringify(crossRoleRead));
  assert.equal(crossRoleRead.structuredContent.error.code, 'validation');
  assert.match(crossRoleRead.structuredContent.error.message, /task-selected role/);
  const selectedRoleMemory = await clientA.callTool({
    name: 'get_project_agent_memory',
    arguments: {
      personalSpaceId: fixture.context.personal_space_id,
      personalProjectId: fixture.context.personal_project_id,
      agentId: 'engineer'
    }
  });
  assert.equal(selectedRoleMemory.isError, undefined, JSON.stringify(selectedRoleMemory));
  assert.equal(selectedRoleMemory.structuredContent.revision, 0);

  const rejected = await clientB.callTool({
    name: 'checkpoint_task_knowledge',
    arguments: {
      taskContextToken: token, disposition: 'retain_nothing',
      reason: 'A foreign project must not complete this task.'
    }
  });
  assert.equal(rejected.isError, true, JSON.stringify(rejected));
  assert.equal(rejected.structuredContent.error.code, 'validation');
  assert.match(rejected.structuredContent.error.message, /another project/);
  assert.equal((await fixture.memory()).revision, 0);

  const rejectedPeer = await clientAPeer.callTool({
    name: 'checkpoint_task_knowledge',
    arguments: {
      taskContextToken: token, disposition: 'retain_nothing',
      reason: 'Another remote session must not complete this task.'
    }
  });
  assert.equal(rejectedPeer.isError, true, JSON.stringify(rejectedPeer));
  assert.equal(rejectedPeer.structuredContent.error.code, 'validation');
  assert.match(rejectedPeer.structuredContent.error.message, /another remote session/);
  assert.equal((await fixture.memory()).revision, 0);

  const stillPending = await clientA.callTool({
    name: 'verify_task_checkpoint', arguments: { sessionId: 'remote' }
  });
  assert.equal(stillPending.structuredContent.decision, 'block');
  const accepted = await clientA.callTool({
    name: 'checkpoint_task_knowledge',
    arguments: {
      taskContextToken: token, disposition: 'retain_nothing',
      reason: 'The owning remote project completes its own task.'
    }
  });
  assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
  assert.equal(accepted.structuredContent.status, 'checkpointed');
  assert.equal((await fixture.memory()).revision, 0);
});

test('atomic preparation rolls back a failed memory CAS and accepts a merged retry', {
  skip: !realTaskContextEnabled, timeout: 90_000
}, async (t) => {
  const fixture = await realTaskContextProvider(t);
  const app = application(fixture.config);
  await callAgentTool(app, 'checkpoint_project_agent_memory', {
    personalSpaceId: fixture.context.personal_space_id,
    personalProjectId: fixture.context.personal_project_id, agentId: 'engineer',
    sourceApplication: 'codex', expectedRevision: 0, idempotencyKey: 'synthetic-other-writer',
    memory: { summary: 'Another host has updated the memory.' }
  });
  const input = { taskContextToken: fixture.context.token, sourceApplication: 'codex',
    disposition: 'retain_nothing', reason: 'Retain the merged private context.',
    agentMemory: { expectedRevision: 0, memory: { summary: 'Merged context.' } } };
  await assert.rejects(callAgentTool(app, 'checkpoint_task_knowledge', input), /memory changed/);
  assert.equal((await taskRecord(fixture)).checkpoint, null, 'failed CAS must release the claim');
  assert.equal((await fixture.memory()).revision, 1);
  const merged = { ...input, agentMemory: { ...input.agentMemory, expectedRevision: 1 } };
  const result = await callAgentTool(app, 'checkpoint_task_knowledge', merged);
  assert.equal(result.agent_memory.revision, 2);
  assert.equal((await taskRecord(fixture)).checkpoint.phase, 'complete');
  const replay = await callAgentTool(application(fixture.config), 'checkpoint_task_knowledge', merged);
  assert.equal(replay.replayed, true);
  assert.equal((await fixture.memory()).revision, 2);
});

test('a lost atomic prepare response retries in another application without duplicate memory', {
  skip: !realTaskContextEnabled, timeout: 90_000
}, async (t) => {
  const fixture = await realTaskContextProvider(t);
  let lost = false;
  const app = application(fixture.config, async (url, options) => {
    const response = await fetch(url, options);
    if (!lost && options?.method === 'PUT' && new URL(url).pathname.endsWith('/checkpoint')
      && JSON.parse(options.body).phase === 'prepare') {
      assert.equal(response.ok, true);
      await response.arrayBuffer();
      lost = true;
      throw new Error('Synthetic lost prepare response after commit');
    }
    return response;
  });
  const input = { taskContextToken: fixture.context.token, sourceApplication: 'codex',
    disposition: 'retain_nothing', reason: 'Remember this synthetic milestone.',
    agentMemory: { expectedRevision: 0, memory: { summary: 'One committed milestone.' } } };
  await assert.rejects(callAgentTool(app, 'checkpoint_task_knowledge', input),
    error => error.code === 'provider_unavailable');
  assert.equal(lost, true);
  const prepared = await taskRecord(fixture);
  assert.equal(prepared.checkpoint.phase, 'prepare');
  assert.equal(prepared.checkpoint.agent_memory, undefined, 'lifecycle must not copy raw memory');
  assert.equal((await fixture.memory()).revision, 1);
  const result = await callAgentTool(application(fixture.config), 'checkpoint_task_knowledge', input);
  assert.equal(result.agent_memory.revision, 1);
  assert.equal((await fixture.memory()).revision, 1);
  assert.equal((await taskRecord(fixture)).checkpoint.phase, 'complete');
});

function taskRecord(fixture) {
  return fixture.request(`/v1/task-contexts/${fixture.context.token}?${new URLSearchParams({
    personal_space_id: fixture.context.personal_space_id, source_application: 'codex'
  })}`, undefined, 'GET');
}

test('atomic preparation keeps Provider client authorization and rolls back its claim on denial', {
  skip: !realTaskContextEnabled, timeout: 90_000
}, async (t) => {
  const fixture = await realTaskContextProvider(t);
  await fixture.request('/v1/project-agents', {
    personal_space_id: fixture.context.personal_space_id,
    personal_project_id: fixture.context.personal_project_id, agent_id: 'engineer',
    profile: { name: 'Synthetic engineer', responsibility: 'Maintain the synthetic sample.',
      allowed_clients: ['cursor'], work_kinds: ['implementation'], capabilities: ['coding'] }
  }, 'PUT');
  const response = await fetch(`${fixture.config.personal.providerUrl}/v1/task-contexts/${fixture.context.token}/checkpoint`, {
    method: 'PUT', headers: { 'content-type': 'application/json',
      authorization: `Bearer ${fixture.config.personal.accessToken}` },
    body: JSON.stringify({ personal_space_id: fixture.context.personal_space_id,
      source_application: 'codex', phase: 'prepare', disposition: 'retain_nothing',
      reason: 'Rejected source cannot write private memory.', fingerprint: 'a'.repeat(64),
      agent_memory: { expected_revision: 0, memory: { summary: 'Must not be saved.' } } }),
    signal: AbortSignal.timeout(30_000)
  });
  assert.equal(response.status, 403);
  await response.arrayBuffer();
  assert.equal((await taskRecord(fixture)).checkpoint, null);
  assert.equal((await fixture.memory()).revision, 0);
});
