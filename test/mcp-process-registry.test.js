import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { liveMcpProcesses, noteClientChanged, sessionsAwaitingRestart, outdatedMcpNotice, outdatedMcpProcesses, registerMcpProcess, TASK_ENTRY_CONTRACT, withOutdatedMcpNotice }
  from '../src/mcp/process-registry.js';

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

test('a server on an older task-entry contract is named as possibly unable to read the token, and recorded', () => {
  const { dir, config } = fixture();
  try {
    const isAlive = () => true;
    const clock = () => new Date('2026-11-04T00:00:00.000Z');
    // A server from before the contract records none.
    const { recordSession } = registerMcpProcess(config, { sourceApplication: 'claude_code', version: '0.23.0-beta.4', pid: 501,
      entryContract: null });
    recordSession('session-old');

    const own = outdatedMcpNotice(config, { sourceApplication: 'claude_code', version: '0.23.0-beta.8', sessionId: 'session-old',
      isAlive, clock });
    assert.match(own, /^This session's FULI MCP connection runs FULI 0\.23\.0-beta\.4, older than the installed 0\.23\.0-beta\.8; it may not read this taskContextToken\./);
    assert.match(own, /restart this session's FULI MCP connection or open a new session/);
    assert.match(own, /get_collaboration_preferences/);
    assert.match(own, /本会话的 FULI MCP 连接还是 0\.23\.0-beta\.4/);

    const other = outdatedMcpNotice(config, { sourceApplication: 'claude_code', version: '0.23.0-beta.8', sessionId: 'session-new',
      isAlive, clock });
    assert.match(other, /^1 open claude_code session\(s\) still have a FULI MCP connection on FULI 0\.23\.0-beta\.4.*If this session is one and a FULI call with it fails/);

    const recorded = readdirSync(join(dir, 'mcp-processes')).filter(name => name.startsWith('noticed-'))
      .map(name => JSON.parse(readFileSync(join(dir, 'mcp-processes', name), 'utf8')));
    assert.deepEqual(recorded.map(({ sessionId, kind }) => [sessionId, kind]).sort(),
      [['session-new', 'maybe_this_session'], ['session-old', 'this_session']]);
    assert.deepEqual(recorded[0].versions, ['0.23.0-beta.4']);
    assert.equal(recorded[0].installed, '0.23.0-beta.8');
    assert.equal(recorded[0].noticedAt, '2026-11-04T00:00:00.000Z');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a server of another version on the same contract only hears about the update', () => {
  const { dir, config } = fixture();
  try {
    const { recordSession } = registerMcpProcess(config, { sourceApplication: 'claude_code', version: '0.23.0-beta.8', pid: 601,
      entryContract: TASK_ENTRY_CONTRACT });
    recordSession('session-a');
    const notice = outdatedMcpNotice(config, { sourceApplication: 'claude_code', version: '0.23.0-beta.9', sessionId: 'session-a',
      isAlive: () => true });
    assert.match(notice, /^FULI 0\.23\.0-beta\.9 is installed, but 1 open claude_code session\(s\) still run FULI 0\.23\.0-beta\.8\. Restart/);
    assert.doesNotMatch(notice, /taskContextToken/);
    assert.equal(liveMcpProcesses(config, { isAlive: () => true })[0].entryContract, TASK_ENTRY_CONTRACT);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exited servers are forgotten and unregister removes the record', () => {
  const { dir, config } = fixture();
  try {
    registerMcpProcess(config, { sourceApplication: 'codex', version: 'old', pid: 201 });
    const { unregister } = registerMcpProcess(config, { sourceApplication: 'codex', version: 'old', pid: 202 });
    assert.deepEqual(outdatedMcpProcesses(config, { sourceApplication: 'codex', version: 'new', isAlive: pid => pid === 202 }).map(r => r.pid), [202]);
    assert.ok(!readdirSync(join(dir, 'mcp-processes')).includes('201.json'));
    unregister();
    assert.deepEqual(outdatedMcpProcesses(config, { sourceApplication: 'codex', version: 'new', isAlive: () => true }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a server keeps the sessions it answered, newest last and bounded, and rewrites only on a change', () => {
  const { dir, config } = fixture();
  try {
    const { recordSession } = registerMcpProcess(config, { sourceApplication: 'codex', version: 'old', pid: 301 });
    const path = join(dir, 'mcp-processes', '301.json');
    const sessionIds = () => liveMcpProcesses(config, { isAlive: () => true })[0].sessionIds;
    assert.deepEqual(sessionIds(), []);
    recordSession('thread-a');
    recordSession('thread-b');
    const written = statSync(path, { bigint: true });
    recordSession('thread-b');
    assert.equal(statSync(path, { bigint: true }).ino, written.ino);
    recordSession('thread-a');
    assert.deepEqual(sessionIds(), ['thread-b', 'thread-a']);
    // Neither an empty nor an over-long ID is kept.
    recordSession('');
    recordSession('x'.repeat(513));
    recordSession(null);
    assert.deepEqual(sessionIds(), ['thread-b', 'thread-a']);
    for (let index = 0; index < 10; index += 1) recordSession(`thread-${index}`);
    assert.deepEqual(sessionIds(), ['thread-2', 'thread-3', 'thread-4', 'thread-5', 'thread-6', 'thread-7', 'thread-8', 'thread-9']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed session write never fails the call', () => {
  const { dir, config } = fixture();
  try {
    const { recordSession } = registerMcpProcess(config, { sourceApplication: 'codex', version: 'old', pid: 401 });
    rmSync(join(dir, 'mcp-processes'), { recursive: true, force: true });
    writeFileSync(join(dir, 'mcp-processes'), 'not a directory');
    assert.doesNotThrow(() => recordSession('thread-a'));
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

test('a session opened before its client changed waits for a restart; one opened after does not, and it is told once', () => {
  const { dir, config } = fixture();
  try {
    const isAlive = () => true;
    const old = registerMcpProcess(config, { sourceApplication: 'codex', version: '1.0.0', pid: 201, sessionStartedAt: '2026-11-01T00:00:00.000Z' });
    old.recordSession('thread-old');
    registerMcpProcess(config, { sourceApplication: 'codex', version: '1.0.0', pid: 202, sessionStartedAt: '2026-11-03T00:00:00.000Z' }).recordSession('thread-new');
    registerMcpProcess(config, { sourceApplication: 'cursor', version: '1.0.0', pid: 203, sessionStartedAt: '2026-11-01T00:00:00.000Z' });
    noteClientChanged(config, 'codex', new Date('2026-11-02T00:00:00.000Z'));

    assert.deepEqual(sessionsAwaitingRestart(config, { isAlive }),
      [{ sourceApplication: 'codex', count: 1, changedAt: '2026-11-02T00:00:00.000Z', sessions: ['thread-old'] }]);
    const notice = input => outdatedMcpNotice(config, { sourceApplication: 'codex', version: '1.0.0', isAlive, ...input });
    assert.match(notice({ sessionId: 'thread-old' }), /restart this session/);
    assert.equal(notice({ sessionId: 'thread-old' }), null, 'once');
    assert.equal(notice({ sessionId: 'thread-new' }), null);

    old.unregister();
    assert.deepEqual(sessionsAwaitingRestart(config, { isAlive }), [], 'closing the session clears it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the relay keeps the session start across a swap, so a moved server still counts as the old session', () => {
  const { dir, config } = fixture();
  try {
    registerMcpProcess(config, { sourceApplication: 'codex', version: '1.0.0', pid: 301, sessionStartedAt: '2026-11-01T00:00:00.000Z' });
    const [record] = liveMcpProcesses(config, { isAlive: () => true });
    assert.equal(record.sessionStartedAt, '2026-11-01T00:00:00.000Z');
    assert.notEqual(record.startedAt, record.sessionStartedAt);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
