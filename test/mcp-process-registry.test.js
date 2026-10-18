import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { outdatedMcpNotice, outdatedMcpProcesses, registerMcpProcess, withOutdatedMcpNotice } from '../src/mcp/process-registry.js';

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fuli-mcp-registry-'));
  return { dir, config: join(dir, 'graph-runtime.json') };
};

test('an older server of the same client is reported once per session, others stay quiet', () => {
  const { dir, config } = fixture();
  try {
    const live = new Set([101, 102, 103]);
    const isAlive = pid => live.has(pid);
    registerMcpProcess(config, { sourceApplication: 'codex', version: '0.20.0-rc.1', pid: 101 });
    registerMcpProcess(config, { sourceApplication: 'codex', version: '0.20.0', pid: 102 });
    registerMcpProcess(config, { sourceApplication: 'claude_code', version: '0.19.0', pid: 103 });
    assert.deepEqual(outdatedMcpProcesses(config, { sourceApplication: 'codex', version: '0.20.0', isAlive }).map(r => r.pid), [101]);

    const notice = outdatedMcpNotice(config, { sourceApplication: 'codex', version: '0.20.0', sessionId: 'thread-a', isAlive });
    assert.match(notice, /1 open codex session\(s\) still run FULI 0\.20\.0-rc\.1/);
    assert.equal(outdatedMcpNotice(config, { sourceApplication: 'codex', version: '0.20.0', sessionId: 'thread-a', isAlive }), null);
    assert.ok(outdatedMcpNotice(config, { sourceApplication: 'codex', version: '0.20.0', sessionId: 'thread-b', isAlive }));
    assert.equal(outdatedMcpNotice(config, { sourceApplication: 'claude_code', version: '0.19.0', sessionId: 'x', isAlive }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exited servers are forgotten and unregister removes the record', () => {
  const { dir, config } = fixture();
  try {
    registerMcpProcess(config, { sourceApplication: 'codex', version: 'old', pid: 201 });
    const unregister = registerMcpProcess(config, { sourceApplication: 'codex', version: 'old', pid: 202 });
    assert.deepEqual(outdatedMcpProcesses(config, { sourceApplication: 'codex', version: 'new', isAlive: pid => pid === 202 }).map(r => r.pid), [202]);
    assert.ok(!readdirSync(join(dir, 'mcp-processes')).includes('201.json'));
    unregister();
    assert.deepEqual(outdatedMcpProcesses(config, { sourceApplication: 'codex', version: 'new', isAlive: () => true }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the notice is appended to the hook output without touching the rest', () => {
  const output = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'ctx' } };
  assert.equal(withOutdatedMcpNotice(output, null), output);
  const merged = withOutdatedMcpNotice(output, 'restart');
  assert.equal(merged.systemMessage, 'restart');
  assert.equal(merged.hookSpecificOutput.additionalContext, 'ctx\nrestart');
  assert.equal(merged.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});
