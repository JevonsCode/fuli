import assert from 'node:assert/strict';
import test from 'node:test';
import { hookAdditionalContextToolResult } from '../src/mcp/tool-result.js';
import { listAgentTools } from '../src/agent-tools.js';
import { jsonSchemaToZod } from '../src/mcp/tool-schema.js';

const options = { hookEventName: 'UserPromptSubmit', label: 'Synthetic task context',
  limitBytes: 128 * 1024, itemLimit: 1000 };

test('the public coordinator accepts the first task token for recruitment handoff', () => {
  const tool = listAgentTools().find(tool => tool.name === 'coordinate_project_agent_task');
  const input = { taskContextToken: 'fuli-task-first-team', projectPath: '/synthetic/project',
    idempotencyKey: 'synthetic-first-team', title: 'Synthetic first task', objective: 'Adopt the recruited role',
    workKind: 'implementation', routingReason: 'Synthetic scope', contextQueries: ['project'] };
  assert.equal(jsonSchemaToZod(tool.inputSchema).safeParse(input).success, true);
});

test('a growing preference collection does not silently truncate employee memory', () => {
  const payload = { taskContextToken: 'fuli-task-synthetic-context',
    effective_preferences: Array.from({ length: 40 }, (_, i) => ({ id: `rule-${i}`, content: 'Scoped instruction '.repeat(40) })),
    project_agent_context: { status: 'ready', memory: { revision: 4, current: {
      memory: { summary: 'Synthetic project history. '.repeat(120) }
    } } } };
  const result = hookAdditionalContextToolResult(payload, options);
  assert.deepEqual(result.structuredContent, payload);
  assert.equal(result.structuredContent.effective_preferences.length, 40);
  assert.equal(JSON.parse(result.content[0].text).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});

test('oversized hook delivery explicitly requires recovery rather than claiming complete context', () => {
  const result = hookAdditionalContextToolResult({ taskContextToken: 'fuli-task-synthetic-context',
    project_agent_context: { memory: { summary: 'x'.repeat(200_000) } } }, options);
  assert.equal(result.structuredContent.truncated, true);
  const context = JSON.parse(result.content[0].text).hookSpecificOutput.additionalContext;
  assert.match(context, /Context delivery is incomplete/);
  assert.match(context, /get_project_agent_memory/);
  assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) <= options.limitBytes);
});
