import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyClaudeCaseStatus,
  composeResourcesRemoved,
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
