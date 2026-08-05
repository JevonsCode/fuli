import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyClaudeCaseStatus,
  composeResourcesRemoved,
  resolveAlignmentTimeouts,
  summarizeMcpToolResultError,
  summarizeClaudeExecutionError
} from '../acceptance/alignment/benchmark-policy.js';

test('Claude inference-gateway failures are infrastructure errors, not product failures', () => {
  assert.equal(classifyClaudeCaseStatus({
    passed: false,
    errors: [
      'API Error: 502 status code. Check your inference gateway (127.0.0.1:3456).'
    ]
  }), 'ERROR');
});

test('Claude behavioral mismatches remain product failures', () => {
  assert.equal(classifyClaudeCaseStatus({
    passed: false,
    errors: []
  }), 'FAIL');
});

test('missing results, MCP tool errors, and Provider 5xx are infrastructure errors', () => {
  assert.equal(classifyClaudeCaseStatus({
    passed: false,
    errors: ['Claude produced no result event.']
  }), 'ERROR');
  assert.equal(classifyClaudeCaseStatus({
    passed: false,
    errors: [summarizeMcpToolResultError({
      name: 'mcp__fuli__search_current_project_knowledge',
      summary: 'InputValidationError: sent {"spaceId":"private-id","token":"secret"}'
    })]
  }), 'ERROR');
  assert.equal(
    summarizeMcpToolResultError({
      name: 'mcp__fuli__search_current_project_knowledge',
      summary: 'InputValidationError: sent {"spaceId":"private-id","token":"secret"}'
    }),
    'MCP tool_result error (mcp__fuli__search_current_project_knowledge): input validation error.'
  );
  assert.equal(classifyClaudeCaseStatus({
    passed: false,
    errors: ['provider_http_5xx: Provider returned HTTP 500.']
  }), 'ERROR');
  assert.equal(classifyClaudeCaseStatus({
    passed: false,
    errors: []
  }), 'FAIL');
});

test('alignment timeout defaults share the Claude budget and allow scoped overrides', () => {
  assert.deepEqual(resolveAlignmentTimeouts({}), {
    claudeProcessTimeoutMs: 240_000,
    providerRequestTimeoutMs: 240_000,
    hookTimeoutSec: 240,
    hookSmokeTimeoutMs: 240_000
  });
  assert.deepEqual(resolveAlignmentTimeouts({
    FULI_ALIGNMENT_CLAUDE_TIMEOUT_MS: '90000',
    FULI_ALIGNMENT_PROVIDER_TIMEOUT_MS: '60000',
    FULI_ALIGNMENT_HOOK_TIMEOUT_SEC: '75',
    FULI_ALIGNMENT_HOOK_SMOKE_TIMEOUT_MS: '95000'
  }), {
    claudeProcessTimeoutMs: 90_000,
    providerRequestTimeoutMs: 60_000,
    hookTimeoutSec: 75,
    hookSmokeTimeoutMs: 95_000
  });
});

test('successful Claude behavior remains a pass', () => {
  assert.equal(classifyClaudeCaseStatus({
    passed: true,
    errors: []
  }), 'PASS');
});

test('Claude gateway errors are reduced to a sanitized diagnostic', () => {
  const raw = [
    'claude exited with code 1:',
    '{"session_id":"private-session","content":[{"type":"text",',
    '"text":"API Error: 502 status code (no body). Check your inference gateway ',
    '(127.0.0.1:3456)."}]}'
  ].join('');
  assert.equal(
    summarizeClaudeExecutionError(raw),
    'Claude API returned HTTP 502 through the configured inference gateway.'
  );
});

test('compose cleanup is complete only when no labelled resource remains', () => {
  assert.equal(composeResourcesRemoved({
    containers: '',
    networks: ' \n',
    volumes: ''
  }), true);
  assert.equal(composeResourcesRemoved({
    containers: '4ed7ac9c1f8a\n',
    networks: '',
    volumes: ''
  }), false);
  assert.equal(composeResourcesRemoved({
    containers: '',
    networks: '',
    volumes: 'fuli-alignment-example_neo4j_data\n'
  }), false);
});
