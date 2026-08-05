import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationError } from '../src/app/application-error.js';
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
