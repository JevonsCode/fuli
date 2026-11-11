import test from 'node:test';
import assert from 'node:assert/strict';

import { formatSetupPreview, formatSetupResult, runSetupCommand } from '../src/cli/setup-command.js';
import { applyLocalSetup, planLocalSetup } from '../src/setup/setup.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';
import { fakeClientInstaller } from '../test-support/fake-client-installer.js';

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

test('connected-only setup refreshes clients with the FULI entry, not newly detected or skill-only clients', async () => {
  const output = [];
  const agents = [
    { id: 'codex', available: true, integrationDetails: { mcp: 'current' } },
    { id: 'cursor', available: true, integrationDetails: { mcp: 'outdated' } },
    { id: 'claude-code', label: 'Claude Code', available: true, integrationStatus: 'update_available', integrationDetails: { mcp: 'missing', skills: 'outdated' } },
    { id: 'claude-desktop', label: 'Claude Desktop', available: true, integrationStatus: 'not_connected', integrationDetails: { mcp: 'missing' } },
    // DeepSeek Harness has no MCP file: its plugin bundle is the entry, and it is refreshed by its plugin.
    { id: 'dsh', label: 'DeepSeek Harness', available: true, integrationDetails: { skills: 'current', plugin: 'outdated' } }
  ];
  await runSetupCommand(['--yes', '--connected-only'], {
    planSetup: () => ({ ...samplePlan(), agents }),
    applySetup: async (plan) => {
      assert.deepEqual(plan.agents.filter(({ selected }) => selected).map(({ id }) => id), ['codex', 'cursor', 'dsh']);
      return { status: 'ready', runtime: {}, agents: [] };
    },
    write: (line) => output.push(line)
  });
  assert.match(output.join('\n'), /Claude Code: skipped.*no Fuli entry/);
  assert.doesNotMatch(output.join('\n'), /Claude Desktop: skipped/);
});

test('setup reminds existing clients to reconnect after a manual package upgrade even when config is unchanged', () => {
  const output = formatSetupResult({ status: 'ready', runtime: {}, agents: [
    { label: 'Example client', status: 'connected', newTaskRequired: false }
  ] });
  assert.match(output, /After a package upgrade, reconnect Fuli/);
});

test('setup says which port the start moved by itself before the address to open', () => {
  const output = formatSetupResult({ status: 'ready', agents: [], runtime: { url: 'http://127.0.0.1:2728',
    portMoves: [{ key: 'console', from: 2727, to: 2728, reason: 'in_use' }] } });
  assert.match(output, /Another program uses port 2727, so the management UI now uses port 2728\. The new port is saved\.\nOpen: http:\/\/127\.0\.0\.1:2728/);
});

test('setup limits the data directory before anything is written into it, and says so when it could not', async () => {
  const order = [];
  const result = await applyLocalSetup({ ...samplePlan(), agents: [] }, OPTIONS, {
    keepDataDirectoryPrivate: async (dataDir) => { order.push(['private', dataDir]); return false; },
    beginFirstRun: () => order.push(['first run']),
    ensureRuntime: async () => { order.push(['runtime']); return { status: 'running', url: null, pid: 1 }; }
  });
  assert.deepEqual(order, [['private', 'C:/Fuli'], ['first run'], ['runtime']]);
  assert.equal(result.dataDirPrivate, false);
  assert.match(formatSetupResult(result, samplePlan()), /Data directory: other accounts may still read it; the console's 体检 \(doctor\) can limit it to you and SYSTEM\./);

  const limited = await applyLocalSetup({ ...samplePlan(), agents: [] }, OPTIONS, {
    keepDataDirectoryPrivate: async () => true, ensureRuntime: async () => ({ status: 'running', url: null, pid: 1 }) });
  assert.equal('dataDirPrivate' in limited, false);
  assert.doesNotMatch(formatSetupResult(limited, samplePlan()), /Data directory:/);
});

test('partial setup returns a failure exit code for automated updates', async () => {
  const result = await runSetupCommand(['--yes'], {
    planSetup: () => samplePlan(),
    applySetup: async () => ({ status: 'partial', runtime: {}, agents: [] }),
    write: () => {}
  });
  assert.equal(result.exitCode, 1);
});

test('setup ends with the data format migrations that wait, when there are any', async () => {
  const output = [];
  const dataDirs = [];
  await runSetupCommand(['--yes'], {
    planSetup: () => samplePlan(),
    applySetup: async () => ({ status: 'complete', runtime: {}, agents: [] }),
    migrationNotice: (dataDir) => { dataDirs.push(dataDir); return 'Data format migrations wait for you: synthetic'; },
    write: (line) => output.push(line)
  });
  assert.deepEqual(dataDirs, ['C:/Fuli']);
  assert.equal(output.at(-1), 'Data format migrations wait for you: synthetic');
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

test('local setup planning is side-effect free and describes detected agents', async () => {
  let mutated = false;
  const plan = await planLocalSetup({ ...OPTIONS, port: null }, {
    resolvePaths: () => ({
      dataDir: 'C:/Fuli',
      backupDir: 'C:/Fuli/backups/agents',
      mcpServerPath: 'C:/Package/src/mcp-server.js',
      runtimeSettingsPath: 'C:/Fuli/runtime-settings.json'
    }),
    readSettings: () => SAVED_RUNTIME_SETTINGS,
    settingsExist: () => true,
    detect: async () => ({ status: 'available', agents: [
      { id: 'codex', label: 'Codex', available: true, configPath: 'C:/Codex/config.toml' },
      { id: 'claude-code', label: 'Claude Code', available: false, configPath: 'C:/x' }
    ] }),
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

test('local setup recommends native mode on a low-memory Mac without overriding the choice', async () => {
  const dependencies = {
    resolvePaths: () => ({
      dataDir: 'C:/Fuli',
      runtimeSettingsPath: null,
      adaptiveRuntimeSettingsPath: null,
      mcpServerPath: 'C:/Package/src/mcp-server.js'
    }),
    detect: async () => ({ status: 'available', agents: [] }),
    platform: 'darwin',
    hostTotalMemory: () => 16 * 1024 ** 3
  };

  const recommended = await planLocalSetup({ ...OPTIONS, port: null }, dependencies);
  assert.equal(recommended.runtimeSettings.graphRuntimeMode, 'container');
  assert.deepEqual(recommended.runtimeModeRecommendation, {
    recommendedMode: 'native',
    reason: 'low-memory-mac',
    hostTotalBytes: 16 * 1024 ** 3
  });

  const selected = await planLocalSetup({
    ...OPTIONS,
    port: null,
    runtimeMode: 'native'
  }, dependencies);
  assert.equal(selected.runtimeSettings.graphRuntimeMode, 'native');
});

test('first setup on Windows picks ports outside the ranges Windows reserves; saved or chosen ports stay', async () => {
  const reserved = [{ start: 2634, end: 2733 }, { start: 7600, end: 7699 }];
  const platforms = [];
  const dependencies = (settingsExist) => ({
    resolvePaths: () => ({ dataDir: 'C:/Fuli', runtimeSettingsPath: 'C:/Fuli/runtime-settings.json',
      mcpServerPath: 'C:/Package/src/mcp-server.js' }),
    readSettings: () => DEFAULT_RUNTIME_SETTINGS,
    settingsExist: () => settingsExist,
    readReservedRanges: ({ platform }) => { platforms.push(platform); return reserved; },
    detect: async () => ({ status: 'available', agents: [] }),
    platform: 'win32'
  });

  const first = await planLocalSetup({ ...OPTIONS, port: null }, dependencies(false));
  assert.equal(first.runtimeSettings.ports.console, 2734);
  assert.equal(first.runtimeSettings.ports.personalNeo4jBolt, 7700);
  assert.equal(first.runtimeSettings.ports.personalProvider, DEFAULT_RUNTIME_SETTINGS.ports.personalProvider);
  assert.deepEqual(platforms, ['win32']);
  assert.match(formatSetupPreview(first, { ...OPTIONS, port: null }), /Management UI: http:\/\/127\.0\.0\.1:2734/);

  assert.equal((await planLocalSetup({ ...OPTIONS, port: null }, dependencies(true))).runtimeSettings.ports.console, 2727,
    'an existing installation keeps its saved ports');
  assert.equal((await planLocalSetup({ ...OPTIONS, port: 2727 }, dependencies(false))).runtimeSettings.ports.console, 2727,
    'a port the person passed is kept');
  assert.deepEqual(platforms, ['win32']);
});

test('applying setup starts the runtime and connects available agents through agent-installer',
  async () => {
    let runtimeInput = null;
    const installer = fakeClientInstaller([{ id: 'codex' }], { actionCodes: { codex: ['new_session', 'trust_hooks'] } });
    const result = await applyLocalSetup(samplePlan(), { ...OPTIONS, memoryProfile: 'low' }, {
      ensureRuntime: async (input) => {
        runtimeInput = input;
        return ({
          status: 'started',
          url: 'http://127.0.0.1:2727',
          pid: 123
        });
      },
      clientInstaller: installer
    });

    assert.deepEqual(installer.calls, [['apply', ['codex']]]);
    assert.equal(runtimeInput.personalOnly, true);
    assert.equal(runtimeInput.memoryProfile, 'low');
    assert.equal(runtimeInput.adaptiveRuntimeSettings, undefined);
    assert.equal(result.status, 'ready');
    assert.equal(result.runtime.status, 'started');
    assert.deepEqual(result.agents, [{
      id: 'codex',
      label: 'Codex',
      status: 'connected',
      restartRequired: false,
      newTaskRequired: true,
      nextSteps: ['Step trust_hooks.'],
      selfCheck: { status: 'passed', details: { mcp: 'current' } }
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
  const installer = { ...fakeClientInstaller([{ id: 'codex' }]),
    apply: async () => { throw Object.assign(new Error('Could not connect Codex to Fuli'), { code: 'write_failed' }); } };
  const result = await applyLocalSetup(samplePlan(), OPTIONS, {
    ensureRuntime: async () => ({ status: 'running', url: 'http://127.0.0.1:2727', pid: 1 }),
    clientInstaller: installer
  });

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.agents, [{
    id: 'codex',
    label: 'Codex',
    status: 'failed',
    message: 'Could not connect Codex to Fuli'
  }]);
});

test('an installer that times out is never retried and says the client may have changed', async () => {
  const installer = { ...fakeClientInstaller([{ id: 'codex' }]),
    apply: async () => { throw Object.assign(new Error('No answer'), { code: 'unknown_outcome' }); } };
  const result = await applyLocalSetup(samplePlan(), OPTIONS, {
    ensureRuntime: async () => ({ status: 'running', url: null, pid: 1 }),
    clientInstaller: installer
  });
  assert.equal(result.agents[0].status, 'failed');
  assert.match(result.agents[0].message, /may or may not have changed.*did not retry/);
});

test('setup reports a partially connected Agent when agent-installer left a component alone', async () => {
  const result = await applyLocalSetup(samplePlan(), OPTIONS, {
    ensureRuntime: async () => ({ status: 'running', url: null, pid: 1 }),
    clientInstaller: fakeClientInstaller([{ id: 'codex' }], { problems: { codex: ['skills: It was changed by hand, so it is left as it is.'] } })
  });

  assert.equal(result.status, 'partial');
  assert.deepEqual(result.agents, [{
    id: 'codex',
    label: 'Codex',
    status: 'partial',
    restartRequired: false,
    message: 'skills: It was changed by hand, so it is left as it is.'
  }]);
});

test('without agent-installer setup connects nothing and says the client component could not be downloaded', async () => {
  const result = await applyLocalSetup(samplePlan(), OPTIONS, {
    ensureRuntime: async () => ({ status: 'running', url: null, pid: 1 }),
    clientInstaller: fakeClientInstaller([{ id: 'codex' }], { unavailable: 'offline' })
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.agents[0].status, 'failed');
  assert.equal(result.agents[0].reason, 'client_component_unavailable');
  assert.match(formatSetupResult(result, samplePlan()), /Codex: connection failed \(无法下载客户端组件 agent-installer，请检查网络后重试。 The client component agent-installer could not be downloaded; check your network connection and try again\.\)/);
  // When it cannot even list the clients, the preview and the result say so.
  const plan = await planLocalSetup({ ...OPTIONS, dataDir: 'C:/Fuli' }, {
    resolvePaths: () => samplePlan().paths, detect: async () => ({ status: 'unavailable', reason: 'agent-installer could not be downloaded: offline' }),
    readSettings: () => SAVED_RUNTIME_SETTINGS, readAdaptiveSettings: () => ({ enabled: false }), settingsExist: () => true
  });
  assert.match(formatSetupPreview(plan, OPTIONS), /Automatic client setup: not possible here\. 无法下载客户端组件/);
  const applied = await applyLocalSetup(plan, OPTIONS, { ensureRuntime: async () => ({ status: 'running', url: null, pid: 1 }) });
  assert.equal(applied.status, 'partial');
  assert.match(formatSetupResult(applied, plan), /Agent clients: not set up\. 无法下载客户端组件.*check your network connection and try again\./);
});

test('applying setup connects only the agents selected during setup', async () => {
  const installer = fakeClientInstaller(multiAgentPlan().map(({ id }) => ({ id })));
  const result = await applyLocalSetup({
    ...samplePlan(),
    agents: multiAgentPlan()
  }, OPTIONS, {
    ensureRuntime: async () => ({ status: 'running', url: null, pid: 1 }),
    clientInstaller: installer
  });

  assert.deepEqual(installer.calls, [['apply', ['claude-code']], ['apply', ['cursor']]]);
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
    assert.match(output[0], /Automatic client setup: Claude Code, Cursor/);
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
      graphRuntimeConfigPath: 'C:/Fuli/graph-runtime.json'
    },
    agents: [
      { id: 'codex', label: 'Codex', available: true },
      { id: 'claude-code', label: 'Claude Code', available: false }
    ]
  };
}

function multiAgentPlan() {
  return [
    { id: 'codex', label: 'Codex', available: true, selected: false },
    { id: 'claude-code', label: 'Claude Code', available: true, selected: true },
    { id: 'cursor', label: 'Cursor', available: true, selected: true }
  ];
}

test('setup output explains why an Agent was not fully connected', () => {
  const output = formatSetupResult({ status: 'partial', runtime: { url: null }, agents: [
    { label: 'Codex', status: 'partial', message: 'EPERM: operation not permitted' },
    { label: 'Cursor', status: 'failed' }
  ] });
  assert.match(output, /Codex: partially configured \(EPERM: operation not permitted\); retry fuli setup/);
  assert.match(output, /Cursor: connection failed; retry fuli setup/);
});

test('applyLocalSetup runs post-connection self-check and formatSetupResult prints the 2-step first-try guide', async () => {
  const result = await applyLocalSetup(samplePlan(), OPTIONS, {
    ensureRuntime: async () => ({ status: 'running', url: 'http://127.0.0.1:2727', pid: 1 }),
    clientInstaller: fakeClientInstaller([{ id: 'codex' }], { actionCodes: { codex: ['new_session'] } })
  });

  assert.equal(result.status, 'ready');
  assert.deepEqual(result.agents[0].selfCheck, { status: 'passed', details: { mcp: 'current' } });

  const output = formatSetupResult(result, samplePlan());
  assert.match(output, /Codex: connected \(self-check passed\); create or reopen a task/);
  assert.match(output, /First-try check: 1\) Tell one connected client a collaboration preference; 2\) Ask another connected client what Fuli remembers\./);
});

test('applyLocalSetup downgrades an Agent to partial when post-connection self-check detects missing or outdated components', async () => {
  const result = await applyLocalSetup(samplePlan(), OPTIONS, {
    ensureRuntime: async () => ({ status: 'running', url: 'http://127.0.0.1:2727', pid: 1 }),
    clientInstaller: fakeClientInstaller([{ id: 'codex' }], { afterApply: 'update_available' })
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.agents[0].status, 'partial');
  assert.equal(result.agents[0].selfCheck.status, 'failed');
  assert.match(result.agents[0].message, /Self-check failed \(mcp=outdated\)/);

  const output = formatSetupResult(result, samplePlan());
  assert.match(output, /Codex: partially configured \(Self-check failed \(mcp=outdated\)\); retry fuli setup/);
});

test('a changed MCP-only client is restarted to load FULI; one that already had it is not', async () => {
  const changed = await applyLocalSetup({ ...samplePlan(), agents: [{ id: 'gemini', label: 'Gemini CLI', available: true }] }, OPTIONS, {
    ensureRuntime: async () => ({ status: 'running', url: null, pid: 1 }),
    clientInstaller: fakeClientInstaller([{ id: 'gemini' }])
  });
  assert.equal(changed.agents[0].restartRequired, true);
  const current = await applyLocalSetup({ ...samplePlan(), agents: [{ id: 'gemini', label: 'Gemini CLI', available: true }] }, OPTIONS, {
    ensureRuntime: async () => ({ status: 'running', url: null, pid: 1 }),
    clientInstaller: fakeClientInstaller([{ id: 'gemini', state: 'connected', mcp: 'current' }])
  });
  assert.equal(current.agents[0].restartRequired, false);
});
