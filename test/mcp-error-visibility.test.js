import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationError } from '../src/app/application-error.js';
import {
  beginTaskContext,
  checkpointTaskKnowledge
} from '../src/graphiti/agent-knowledge-workflows.js';
import { ProviderRequestError } from '../src/graphiti/provider-client.js';
import { errorToolResult } from '../src/mcp/tool-result.js';
import { TaskContextRegistry } from '../src/mcp/task-context-registry.js';

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
