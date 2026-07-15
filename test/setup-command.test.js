import test from 'node:test';
import assert from 'node:assert/strict';

import { runSetupCommand } from '../src/cli/setup-command.js';
import { applyLocalSetup, planLocalSetup } from '../src/setup/setup.js';

const OPTIONS = Object.freeze({
  dataDir: null,
  personalSpaceName: '我',
  port: 5173,
  yes: false,
  skipAgents: false,
  noStart: false
});

test('local setup planning is side-effect free and describes detected agents', () => {
  let mutated = false;
  const plan = planLocalSetup(OPTIONS, {
    resolvePaths: () => ({
      dataDir: 'C:/Fuli',
      dbPath: 'C:/Fuli/context.db',
      backupDir: 'C:/Fuli/backups/agents',
      mcpServerPath: 'C:/Package/src/mcp-server.js'
    }),
    discover: () => [
      { id: 'codex', label: 'Codex', available: true, configPath: 'C:/Codex/config.toml' },
      { id: 'claude-code', label: 'Claude Code', available: false, configPath: 'C:/x' }
    ],
    mutate: () => { mutated = true; }
  });

  assert.equal(mutated, false);
  assert.equal(plan.paths.dbPath, 'C:/Fuli/context.db');
  assert.deepEqual(plan.agents.map(({ label, available }) => ({ label, available })), [
    { label: 'Codex', available: true },
    { label: 'Claude Code', available: false }
  ]);
});

test('applying setup starts the runtime, backs up configs, and connects available agents',
  async () => {
    const calls = [];
    const plan = samplePlan();
    const result = await applyLocalSetup(plan, OPTIONS, {
      ensureRuntime: async () => ({
        status: 'started',
        url: 'http://127.0.0.1:5173',
        pid: 123
      }),
      backupConfig(agent) {
        calls.push(`backup:${agent.id}`);
        return `C:/backup/${agent.id}.bak`;
      },
      connect(agent) {
        calls.push(`connect:${agent.id}`);
        return { id: agent.id, label: agent.label, status: 'connected' };
      }
    });

    assert.deepEqual(calls, ['backup:codex', 'connect:codex']);
    assert.equal(result.status, 'ready');
    assert.equal(result.runtime.status, 'started');
    assert.deepEqual(result.agents, [{
      id: 'codex',
      label: 'Codex',
      status: 'connected',
      backupPath: 'C:/backup/codex.bak'
    }]);
  });

test('an agent failure is isolated and reported without blocking the local runtime', async () => {
  const result = await applyLocalSetup(samplePlan(), OPTIONS, {
    ensureRuntime: async () => ({ status: 'running', url: 'http://127.0.0.1:5173', pid: 1 }),
    backupConfig: () => null,
    connect: () => { throw new Error('Could not connect Codex to Fuli'); }
  });

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.agents, [{
    id: 'codex',
    label: 'Codex',
    status: 'failed',
    message: 'Could not connect Codex to Fuli'
  }]);
});

test('setup command shows one preview and cancellation performs no writes', async () => {
  const output = [];
  let confirmations = 0;
  let applied = false;
  const result = await runSetupCommand([], {
    planSetup: () => samplePlan(),
    applySetup: async () => { applied = true; },
    confirm: async () => {
      confirmations += 1;
      return false;
    },
    write: (line) => output.push(line)
  });

  assert.equal(confirmations, 1);
  assert.equal(applied, false);
  assert.equal(result.status, 'cancelled');
  assert.equal(output.filter((line) => line.includes('本地数据')).length, 1);
});

test('setup command --yes applies without asking and prints a concise ready result', async () => {
  const output = [];
  let confirmations = 0;
  const result = await runSetupCommand(['--yes'], {
    planSetup: () => samplePlan(),
    applySetup: async () => ({
      status: 'ready',
      runtime: { status: 'started', url: 'http://127.0.0.1:5173', pid: 123 },
      agents: [{ id: 'codex', label: 'Codex', status: 'connected', backupPath: null }]
    }),
    confirm: async () => { confirmations += 1; return true; },
    write: (line) => output.push(line)
  });

  assert.equal(confirmations, 0);
  assert.equal(result.status, 'ready');
  assert.match(output.join('\n'), /复利已准备好/);
  assert.match(output.join('\n'), /http:\/\/127\.0\.0\.1:5173/);
});

function samplePlan() {
  return {
    paths: {
      dataDir: 'C:/Fuli',
      dbPath: 'C:/Fuli/context.db',
      backupDir: 'C:/Fuli/backups/agents',
      mcpServerPath: 'C:/Package/src/mcp-server.js'
    },
    agents: [
      { id: 'codex', label: 'Codex', available: true, configPath: 'C:/Codex/config.toml' },
      { id: 'claude-code', label: 'Claude Code', available: false, configPath: 'C:/x' }
    ]
  };
}
