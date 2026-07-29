import test from 'node:test';
import assert from 'node:assert/strict';

import { runSetupCommand } from '../src/cli/setup-command.js';
import { applyLocalSetup, planLocalSetup } from '../src/setup/setup.js';

const OPTIONS = Object.freeze({
  dataDir: null,
  personalSpaceName: '我',
  port: 2727,
  yes: false,
  codexOnly: false,
  skipAgents: false,
  personalOnly: true,
  noStart: false
});

test('personal-only preview explains that public controls stay disconnected', () => {
  const output = [];
  return runSetupCommand(['--personal-only'], {
    planSetup: () => samplePlan(),
    confirm: async () => false,
    write: (line) => output.push(line)
  }).then(() => {
    assert.match(output[0], /仅个人：本机 Graphiti \/ Neo4j/);
    assert.match(output[0], /容器运行时：自动检测/);
    assert.match(output[0], /公共服务：暂不连接/);
  });
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
    inspectInstallations: (agents) => agents,
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
    let runtimeInput = null;
    const plan = samplePlan();
    const result = await applyLocalSetup(plan, OPTIONS, {
      ensureRuntime: async (input) => {
        runtimeInput = input;
        return ({
          status: 'started',
          url: 'http://127.0.0.1:2727',
          pid: 123
        });
      },
      backupConfig(agent) {
        calls.push(`backup:${agent.id}`);
        return `C:/backup/${agent.id}.bak`;
      },
      connect(agent) {
        calls.push(`connect:${agent.id}`);
        return { id: agent.id, label: agent.label, status: 'connected' };
      },
      installSkill(agent) {
        calls.push(`skill:${agent.id}:${agent.skillPath.split('/').at(-1)}`);
        return { status: 'installed', path: agent.skillPath, backupPath: null };
      }
    });

    assert.deepEqual(calls, [
      'backup:codex',
      'connect:codex',
      'skill:codex:capturing-session-knowledge',
      'skill:codex:grilling-project'
    ]);
    assert.equal(runtimeInput.personalOnly, true);
    assert.equal(result.status, 'ready');
    assert.equal(result.runtime.status, 'started');
    assert.deepEqual(result.agents, [{
      id: 'codex',
      label: 'Codex',
      status: 'connected',
      backupPath: 'C:/backup/codex.bak',
      skills: [
        {
          status: 'installed',
          path: 'C:/Users/Test/.agents/skills/capturing-session-knowledge',
          backupPath: null
        },
        {
          status: 'installed',
          path: 'C:/Users/Test/.agents/skills/grilling-project',
          backupPath: null
        }
      ]
    }]);
  });

test('an agent failure is isolated and reported without blocking the local runtime', async () => {
  const result = await applyLocalSetup(samplePlan(), OPTIONS, {
    ensureRuntime: async () => ({ status: 'running', url: 'http://127.0.0.1:2727', pid: 1 }),
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

test('applying setup connects only the agents selected during setup', async () => {
  const calls = [];
  const result = await applyLocalSetup({
    ...samplePlan(),
    agents: multiAgentPlan()
  }, OPTIONS, {
    ensureRuntime: async () => ({ status: 'running', url: null, pid: 1 }),
    backupConfig: (agent) => {
      calls.push(`backup:${agent.id}`);
      return null;
    },
    connect: (agent) => {
      calls.push(`connect:${agent.id}`);
      return { id: agent.id, label: agent.label, status: 'connected' };
    },
    installSkill: (agent) => ({
      status: 'current',
      path: agent.skillPath,
      backupPath: null
    })
  });

  assert.deepEqual(calls, [
    'backup:claude-code',
    'connect:claude-code',
    'backup:cursor',
    'connect:cursor'
  ]);
  assert.deepEqual(result.agents.map(({ id }) => id), ['claude-code', 'cursor']);
});

test('interactive setup lets the user choose multiple detected agents before confirmation',
  async () => {
    const output = [];
    let appliedPlan = null;
    const result = await runSetupCommand([], {
      planSetup: () => ({ ...samplePlan(), agents: multiAgentPlan() }),
      selectAgents: async (agents) => {
        assert.deepEqual(agents.map(({ id }) => id), ['codex', 'claude-code', 'cursor']);
        return ['claude-code', 'cursor'];
      },
      confirm: async () => true,
      applySetup: async (plan) => {
        appliedPlan = plan;
        return {
          status: 'ready',
          runtime: { status: 'running', url: null, pid: 1 },
          agents: []
        };
      },
      write: (line) => output.push(line)
    });

    assert.equal(result.status, 'ready');
    assert.deepEqual(
      appliedPlan.agents.filter(({ selected }) => selected).map(({ id }) => id),
      ['claude-code', 'cursor']
    );
    assert.match(output[0], /Agent：Claude Code、Cursor/);
    assert.doesNotMatch(output[0], /Agent：.*Codex/);
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
  assert.equal(output.filter((line) => line.includes('存储：仅个人：本机 Graphiti / Neo4j')).length, 1);
});

test('setup command --yes applies without asking and prints a concise ready result', async () => {
  const output = [];
  let confirmations = 0;
  const result = await runSetupCommand(['--yes'], {
    planSetup: () => samplePlan(),
    applySetup: async () => ({
      status: 'ready',
      runtime: { status: 'started', url: 'http://127.0.0.1:2727', pid: 123 },
      agents: [{
        id: 'codex',
        label: 'Codex',
        status: 'connected',
        backupPath: null,
        newTaskRequired: true
      }]
    }),
    confirm: async () => { confirmations += 1; return true; },
    write: (line) => output.push(line)
  });

  assert.equal(confirmations, 0);
  assert.equal(result.status, 'ready');
  assert.match(output.join('\n'), /复利已准备好/);
  assert.match(output.join('\n'), /http:\/\/127\.0\.0\.1:2727/);
  assert.match(output.join('\n'), /新建或重新打开一个任务/);
});

function samplePlan() {
  return {
    paths: {
      dataDir: 'C:/Fuli',
      dbPath: 'C:/Fuli/context.db',
      backupDir: 'C:/Fuli/backups/agents',
      mcpServerPath: 'C:/Package/src/mcp-server.js',
      graphRuntimeConfigPath: 'C:/Fuli/graph-runtime.json',
      sessionSkillPath: 'C:/Package/skills/capturing-session-knowledge',
      projectSkillPath: 'C:/Package/skills/grilling-project'
    },
    agents: [
      {
        id: 'codex',
        label: 'Codex',
        available: true,
        configPath: 'C:/Codex/config.toml',
        skillPath: 'C:/Users/Test/.agents/skills/capturing-session-knowledge',
        projectSkillPath: 'C:/Users/Test/.agents/skills/grilling-project'
      },
      { id: 'claude-code', label: 'Claude Code', available: false, configPath: 'C:/x' }
    ]
  };
}

function multiAgentPlan() {
  return [
    {
      id: 'codex',
      label: 'Codex',
      available: true,
      selected: false,
      configPath: 'C:/Codex/config.toml',
      skillPath: 'C:/Users/Test/.agents/skills/capturing-session-knowledge',
      projectSkillPath: 'C:/Users/Test/.agents/skills/grilling-project'
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      available: true,
      selected: true,
      configPath: 'C:/Users/Test/.claude.json',
      skillPath: 'C:/Users/Test/.claude/skills/capturing-session-knowledge',
      projectSkillPath: 'C:/Users/Test/.claude/skills/grilling-project'
    },
    {
      id: 'cursor',
      label: 'Cursor',
      available: true,
      selected: true,
      configPath: 'C:/Users/Test/.cursor/mcp.json',
      skillPath: 'C:/Users/Test/.cursor/skills/capturing-session-knowledge',
      projectSkillPath: 'C:/Users/Test/.cursor/skills/grilling-project'
    }
  ];
}
