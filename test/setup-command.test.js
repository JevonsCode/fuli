import test from 'node:test';
import assert from 'node:assert/strict';

import { runSetupCommand } from '../src/cli/setup-command.js';
import { applyLocalSetup, planLocalSetup } from '../src/setup/setup.js';

const OPTIONS = Object.freeze({
  dataDir: null,
  personalSpaceName: 'Personal',
  port: 2727,
  memoryProfile: null,
  runtimeMode: null,
  adaptiveMemory: null,
  yes: false,
  codexOnly: false,
  skipAgents: false,
  personalOnly: true,
  noStart: false
});
const SAVED_RUNTIME_SETTINGS = Object.freeze({
  version: 1,
  ports: {
    console: 3030,
    personalProvider: 18787,
    personalNeo4jHttp: 17474,
    personalNeo4jBolt: 17687,
    workspaceProvider: 18788,
    workspaceNeo4jHttp: 17475,
    workspaceNeo4jBolt: 17688
  },
  lanAccess: true,
  resourceRefreshSeconds: 10
});

test('personal-only preview explains that public controls stay disconnected', () => {
  const output = [];
  return runSetupCommand(['--personal-only'], {
    planSetup: () => samplePlan(),
    confirm: async () => false,
    write: (line) => output.push(line)
  }).then(() => {
    assert.match(output[0], /Storage: personal only, using local Graphiti \/ Neo4j/);
    assert.match(output[0], /Graph runtime: container; Docker or Rancher Desktop/);
    assert.match(output[0], /Shared services: not connected/);
    assert.match(output[0], /Neo4j memory: saved profile or balanced default/);
    assert.match(output[0], /Adaptive memory: disabled/);
  });
});

test('setup preview recommends native processes on a low-memory Mac', async () => {
  const output = [];
  const plan = samplePlan();
  plan.runtimeModeRecommendation = {
    recommendedMode: 'native',
    reason: 'low-memory-mac',
    hostTotalBytes: 16 * 1024 ** 3
  };
  await runSetupCommand(['--personal-only'], {
    planSetup: () => plan,
    confirm: async () => false,
    write: (line) => output.push(line)
  });

  assert.match(output[0], /Recommendation: native mode avoids shared VM memory/);
  assert.match(output[0], /--runtime-mode native/);
});

test('local setup planning is side-effect free and describes detected agents', () => {
  let mutated = false;
  const plan = planLocalSetup({ ...OPTIONS, port: null }, {
    resolvePaths: () => ({
      dataDir: 'C:/Fuli',
      backupDir: 'C:/Fuli/backups/agents',
      mcpServerPath: 'C:/Package/src/mcp-server.js',
      runtimeSettingsPath: 'C:/Fuli/runtime-settings.json'
    }),
    readSettings: () => SAVED_RUNTIME_SETTINGS,
    discover: () => [
      { id: 'codex', label: 'Codex', available: true, configPath: 'C:/Codex/config.toml' },
      { id: 'claude-code', label: 'Claude Code', available: false, configPath: 'C:/x' }
    ],
    inspectInstallations: (agents) => agents,
    mutate: () => { mutated = true; }
  });

  assert.equal(mutated, false);
  assert.equal(plan.paths.dataDir, 'C:/Fuli');
  assert.equal(plan.runtimeSettings.ports.console, 3030);
  assert.equal(plan.runtimeSettings.ports.personalProvider, 18787);
  assert.equal(plan.runtimeSettings.lanAccess, true);
  assert.deepEqual(plan.agents.map(({ label, available }) => ({ label, available })), [
    { label: 'Codex', available: true },
    { label: 'Claude Code', available: false }
  ]);
});

test('local setup recommends native mode on a low-memory Mac without overriding the choice', () => {
  const dependencies = {
    resolvePaths: () => ({
      dataDir: 'C:/Fuli',
      runtimeSettingsPath: null,
      adaptiveRuntimeSettingsPath: null,
      mcpServerPath: 'C:/Package/src/mcp-server.js'
    }),
    discover: () => [],
    inspectInstallations: (agents) => agents,
    platform: 'darwin',
    hostTotalMemory: () => 16 * 1024 ** 3
  };

  const recommended = planLocalSetup({ ...OPTIONS, port: null }, dependencies);
  assert.equal(recommended.runtimeSettings.graphRuntimeMode, 'container');
  assert.deepEqual(recommended.runtimeModeRecommendation, {
    recommendedMode: 'native',
    reason: 'low-memory-mac',
    hostTotalBytes: 16 * 1024 ** 3
  });

  const selected = planLocalSetup({
    ...OPTIONS,
    port: null,
    runtimeMode: 'native'
  }, dependencies);
  assert.equal(selected.runtimeSettings.graphRuntimeMode, 'native');
});

test('applying setup starts the runtime, backs up configs, and connects available agents',
  async () => {
    const calls = [];
    let runtimeInput = null;
    const plan = samplePlan();
    const result = await applyLocalSetup(plan, { ...OPTIONS, memoryProfile: 'low' }, {
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
      'skill:codex:grilling-project',
      'skill:codex:flreview'
    ]);
    assert.equal(runtimeInput.personalOnly, true);
    assert.equal(runtimeInput.memoryProfile, 'low');
    assert.equal(runtimeInput.adaptiveRuntimeSettings, undefined);
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
        },
        {
          status: 'installed',
          path: 'C:/Users/Test/.agents/skills/flreview',
          backupPath: null
        }
      ]
    }]);
  });

test('applying setup forwards the selected graph runtime mode', async () => {
  let runtimeInput = null;
  await applyLocalSetup({
    ...samplePlan(),
    runtimeSettings: {
      ...SAVED_RUNTIME_SETTINGS,
      graphRuntimeMode: 'native'
    },
    agents: []
  }, { ...OPTIONS, runtimeMode: 'native' }, {
    ensureRuntime: async (input) => {
      runtimeInput = input;
      return { status: 'started', url: null, pid: 1 };
    }
  });

  assert.equal(runtimeInput.runtimeMode, 'native');
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
    assert.match(output[0], /Agents: Claude Code, Cursor/);
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
  assert.equal(output.filter((line) => line.includes(
    'Storage: personal only, using local Graphiti / Neo4j'
  )).length, 1);
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
  assert.match(output.join('\n'), /Fuli is ready/);
  assert.match(output.join('\n'), /http:\/\/127\.0\.0\.1:2727/);
  assert.match(output.join('\n'), /create or reopen a task/);
  assert.doesNotMatch(output.join('\n'), /[\p{Script=Han}]/u);
});

test('setup prints the temporary LAN access code when saved settings enable LAN', async () => {
  const output = [];
  await runSetupCommand(['--yes'], {
    planSetup: () => ({
      ...samplePlan(),
      runtimeSettings: SAVED_RUNTIME_SETTINGS
    }),
    applySetup: async () => ({
      status: 'ready',
      runtime: {
        status: 'started',
        url: 'http://127.0.0.1:3030',
        pid: 3030,
        lan: true,
        lanUrls: ['http://192.168.31.8:3030'],
        lanAccess: { username: 'fuli', accessCode: 'temporary-access-code' }
      },
      agents: []
    }),
    write: (line) => output.push(line)
  });

  assert.match(output.join('\n'), /http:\/\/192\.168\.31\.8:3030/);
  assert.match(output.join('\n'), /Username: fuli/);
  assert.match(output.join('\n'), /Temporary access code: temporary-access-code/);
});

function samplePlan() {
  return {
    paths: {
      dataDir: 'C:/Fuli',
      backupDir: 'C:/Fuli/backups/agents',
      mcpServerPath: 'C:/Package/src/mcp-server.js',
      graphRuntimeConfigPath: 'C:/Fuli/graph-runtime.json',
      sessionSkillPath: 'C:/Package/skills/capturing-session-knowledge',
      projectSkillPath: 'C:/Package/skills/grilling-project',
      reviewSkillPath: 'C:/Package/skills/flreview'
    },
    agents: [
      {
        id: 'codex',
        label: 'Codex',
        available: true,
        configPath: 'C:/Codex/config.toml',
        skillPath: 'C:/Users/Test/.agents/skills/capturing-session-knowledge',
        projectSkillPath: 'C:/Users/Test/.agents/skills/grilling-project',
        reviewSkillPath: 'C:/Users/Test/.agents/skills/flreview'
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
      projectSkillPath: 'C:/Users/Test/.agents/skills/grilling-project',
      reviewSkillPath: 'C:/Users/Test/.agents/skills/flreview'
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      available: true,
      selected: true,
      configPath: 'C:/Users/Test/.claude.json',
      skillPath: 'C:/Users/Test/.claude/skills/capturing-session-knowledge',
      projectSkillPath: 'C:/Users/Test/.claude/skills/grilling-project',
      reviewSkillPath: 'C:/Users/Test/.claude/skills/flreview'
    },
    {
      id: 'cursor',
      label: 'Cursor',
      available: true,
      selected: true,
      configPath: 'C:/Users/Test/.cursor/mcp.json',
      skillPath: 'C:/Users/Test/.cursor/skills/capturing-session-knowledge',
      projectSkillPath: 'C:/Users/Test/.cursor/skills/grilling-project',
      reviewSkillPath: 'C:/Users/Test/.cursor/skills/flreview'
    }
  ];
}
