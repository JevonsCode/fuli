import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import { ApplicationError, InvalidInputError } from '../src/app/application-error.js';
import {
  beginTaskContext,
  checkpointTaskKnowledge
} from '../src/graphiti/agent-knowledge-workflows.js';
import { ProviderRequestError } from '../src/graphiti/provider-client.js';
import { resolvePersonalProjectPath } from '../src/graphiti/project-path-context.js';
import { setSessionCapturePause } from '../src/graphiti/session-capture-pause-request.js';
import { switchSessionFuli } from '../src/graphiti/session-fuli-switch.js';
import { readOwnSessionRecords } from '../src/graphiti/session-records.js';
import { errorToolResult } from '../src/mcp/tool-result.js';
import { createStandingAssignments } from '../src/standing-assignments/port.js';
import { assertJsonObject, positiveInteger, requiredBinding, requiredString, uniqueTextArray } from '../src/validation/values.js';
import { TaskContextRegistry } from './fixtures/in-memory-task-context-registry.js';

// Issue source: WZ.
// Callers need enough detail to correct rejected requests.
test('MCP error results expose provider field-level validation reasons', () => {
  const result = errorToolResult(new ProviderRequestError(
    'Graphiti provider rejected the request — episode.entities[0] — needs a reasoning summary',
    {
      status: 422,
      validationErrors: [{
        field: 'episode.entities[0]',
        message: 'needs a reasoning summary'
      }]
    }
  ));

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'provider_error');
  assert.deepEqual(result.structuredContent.error.validationErrors, [{
    field: 'episode.entities[0]',
    message: 'needs a reasoning summary'
  }]);
  assert.match(result.content[0].text, /episode\.entities\[0\] — needs a reasoning summary/);
});

test('MCP error results do not expose validation details for uncontrolled failures', () => {
  const error = new Error('ECONNREFUSED 127.0.0.1:8787');
  error.validationErrors = [{
    field: 'episode.entities[0]',
    message: 'must not be exposed'
  }];
  const result = errorToolResult(error);

  assert.equal(result.structuredContent.error.code, 'internal_error');
  assert.equal(result.structuredContent.error.message, 'Tool execution failed');
  assert.equal(result.structuredContent.error.validationErrors, undefined);
});

test('superseded task context tokens report a controlled not_found error', () => {
  const registry = new TaskContextRegistry();
  const first = registry.begin({ sessionId: 'session-1', personalProjectId: 'project-1' });
  registry.begin({ sessionId: 'session-1', personalProjectId: 'project-1' });

  let thrown;
  try {
    registry.context(first.token);
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof ApplicationError);
  assert.equal(thrown.code, 'not_found');
  assert.match(thrown.message, /begin_task_context/);
  assert.equal(errorToolResult(thrown).structuredContent.error.code, 'not_found');
});

test('re-checkpointing with a different disposition is a controlled validation error', () => {
  const registry = new TaskContextRegistry();
  const { token } = registry.begin({ sessionId: 'session-2', personalProjectId: null });

  registry.checkpoint(token, { disposition: 'retain_nothing', reason: 'nothing durable' });
  registry.checkpoint(token, { disposition: 'retain_nothing', reason: 'nothing durable' });

  assert.throws(
    () => registry.checkpoint(token, {
      disposition: 'capture_candidates',
      reason: 'other'
    }),
    (error) => error instanceof ApplicationError && error.code === 'validation'
  );
});

test('checkpoint workflow exposes caller-correctable lifecycle validation', async () => {
  const task = {
    token: 'fuli-task-lifecycle-error',
    sessionId: 'session-3',
    personalProjectId: 'project-1',
    projectAgentId: null,
    checkpoint: null
  };
  const application = {
    taskContextRegistry: { context: async () => task }
  };
  const cases = [
    {
      disposition: 'capture_candidates',
      reason: 'A capture payload is required.'
    },
    {
      disposition: 'retain_nothing',
      reason: 'A capture payload is forbidden.',
      capture: { summary: 'Must be rejected.' }
    },
    {
      disposition: 'retain_nothing',
      reason: 'No Agent target exists.',
      agentMemory: { expectedRevision: 0, memory: { summary: 'Must be rejected.' } }
    }
  ];

  for (const input of cases) {
    let thrown;
    try {
      await checkpointTaskKnowledge(application, {
        taskContextToken: task.token,
        sourceApplication: 'codex',
        ...input
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof ApplicationError);
    assert.equal(thrown.code, 'validation');
    assert.equal(errorToolResult(thrown).structuredContent.error.code, 'validation');
  }
});

test('checkpoint workflow preserves actionable fingerprint-conflict guidance', async () => {
  const application = {
    taskContextRegistry: {
      context: async () => ({
        token: 'fuli-task-conflict',
        sessionId: 'session-4',
        personalProjectId: 'project-1',
        projectAgentId: null,
        checkpoint: { phase: 'prepare', fingerprint: 'a'.repeat(64) }
      })
    }
  };

  let thrown;
  try {
    await checkpointTaskKnowledge(application, {
      taskContextToken: 'fuli-task-conflict',
      disposition: 'retain_nothing',
      reason: 'This input has a different fingerprint.',
      sourceApplication: 'codex'
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof ApplicationError);
  assert.equal(thrown.code, 'validation');
  assert.match(thrown.message, /resume the original review|begin a new task context/i);
  assert.match(errorToolResult(thrown).content[0].text, /resume the original review/i);
});

test('checkpoint continuation mismatches are controlled validation errors', async () => {
  const token = 'fuli-task-continuation1';
  const common = {
    sessionId: 'current-session',
    projectPath: '/synthetic/project',
    taskPrompt: `FULI_CHECKPOINT_REQUIRED: ${token} continue`,
    sourceApplication: 'claude_code'
  };
  const wrongSession = {
    taskContextRegistry: {
      context: async () => ({
        token, sessionId: 'another-session', personalProjectId: 'project-1'
      })
    }
  };
  const wrongProject = {
    taskContextRegistry: {
      context: async () => ({
        token, sessionId: 'current-session', personalProjectId: 'project-1'
      })
    },
    getCollaborationPreferences: async () => ({
      context: { personal_project_id: 'project-2', project_agent_id: null }
    })
  };

  for (const application of [wrongSession, wrongProject]) {
    await assert.rejects(
      beginTaskContext(application, common),
      (error) => error instanceof ApplicationError && error.code === 'validation'
    );
  }
});

// rec#48: a caller's wrong argument reaches the Agent as a typed code with what
// to pass, so it can correct the call; a genuine failure stays opaque.
test('a missing native projectPath reports invalid_input with guidance and no path', () => {
  const missing = 'C:\\Users\\synthetic-person\\missing-project';
  assert.ok(path.win32.isAbsolute(missing), 'the path is absolute, so only its existence can fail');
  const probed = [];
  let thrown;
  try {
    resolvePersonalProjectPath(missing, [{ project_id: 'fuli' }], {
      fileExists: (candidate) => { probed.push(candidate); return false; }, isDirectory: () => false,
      realPath: (candidate) => candidate, readText: () => '', pathApi: path.win32
    });
  } catch (error) {
    thrown = error;
  }
  assert.deepEqual(probed, [missing], 'the directory-does-not-exist check is what refused it');
  assert.ok(thrown instanceof TypeError, 'callers that catch TypeError keep working');
  const result = errorToolResult(thrown);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'invalid_input');
  assert.match(result.structuredContent.error.message, /existing absolute directory/);
  assert.match(result.structuredContent.error.message, /Pass the absolute path of the current working directory/);
  assert.doesNotMatch(result.content[0].text, /synthetic-person|missing-project/);
});

test('shared input checks report invalid_input naming the argument, never its value', () => {
  const secret = 'sk-synthetic-secret-value';
  for (const check of [
    () => requiredString(secret, 'connection', 4),
    () => positiveInteger(secret, 'limit', 100),
    () => uniqueTextArray([secret, ''], 'projectIds'),
    () => assertJsonObject(secret, 'policy')
  ]) {
    assert.throws(check, TypeError);
    let thrown;
    try { check(); } catch (error) { thrown = error; }
    const result = errorToolResult(thrown);
    assert.equal(result.structuredContent.error.code, 'invalid_input');
    assert.match(result.structuredContent.error.message, /^(connection|limit|projectIds|policy) /);
    assert.doesNotMatch(result.content[0].text, /sk-synthetic/);
  }
});

test('a genuine internal TypeError stays internal_error', () => {
  for (const error of [new TypeError("Cannot read properties of undefined (reading 'spaceId')"),
    new TypeError('Provider did not return a durable task context')]) {
    const result = errorToolResult(error);
    assert.equal(result.structuredContent.error.code, 'internal_error');
    assert.equal(result.structuredContent.error.message, 'Tool execution failed');
  }
});

// dot's review of fuli#363: a value FULI binds itself (its personal space, the
// host session of a hook or MCP process, a task's stored session, the project
// and lead a confirmation created) is no argument the caller could correct.
// Missing, it is FULI's fault: internal_error, never invalid_input.
test('a missing binding FULI supplies itself stays internal_error, never invalid_input', async (t) => {
  const assignments = createStandingAssignments();
  t.after(() => assignments.close());
  const unbound = [
    ['requiredBinding', () => requiredBinding(undefined, 'personalSpaceId')],
    ['a task without its stored host session', () => setSessionCapturePause({ taskContextRegistry: {
      context: async () => ({ token: 'fuli-task-synthetic', sessionId: null, sourceApplication: 'codex' }) } },
    { taskContextToken: 'fuli-task-synthetic', sessionPaused: true })],
    ['session records without the MCP process client', () => readOwnSessionRecords({ taskContextRegistry: {
      context: async () => assert.fail('nothing is read without the client binding') } }, { taskContextToken: 'fuli-task-synthetic' })],
    ['a session switch without the host session', () => switchSessionFuli({}, { sessionId: null, sourceApplication: 'codex',
      action: 'status' })],
    ['standing assignments without FULI\'s personal space', () => assignments.list(undefined)],
    ['a registration without the lead its confirmation hired', () => assignments.register({ personalSpaceId: 'space',
      projectId: 'project', leadAgentId: null, terms: ['synthetic term'], responsibility: 'synthetic work', source: 'user' })]
  ];
  for (const [name, call] of unbound) {
    let thrown;
    try { await call(); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof TypeError, name);
    assert.equal(thrown instanceof InvalidInputError, false, `${name} is not the caller's input`);
    assert.equal(errorToolResult(thrown).structuredContent.error.code, 'internal_error', name);
  }
});
