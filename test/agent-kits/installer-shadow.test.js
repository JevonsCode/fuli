import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createClientInstallerPort } from '../../src/agent-kits/client-installer.js';
import { agentKitExecutables } from '../../src/agent-kits/executables.js';
import { createInstallerShadow, runInstallerShadow } from '../../src/agent-kits/installer-shadow.js';
import { inspectAgentInstallations } from '../../src/setup/agent-installation-status.js';
import { discoverAgents } from '../../src/setup/agents.js';
import { installAgent } from '../../src/setup/install-agent.js';
import { isolateHomeEnvironment, realAgentKitExecutable } from '../../test-support/agent-kit-binaries.js';

const REPOSITORY = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test('FULI\'s client states are compared with the installer\'s by client and component, codes only', async (t) => {
  const fuli = [
    { id: 'claude-code', integrationStatus: 'connected',
      integrationDetails: { mcp: 'current', skills: 'current', lifecycleHooks: 'current' } },
    { id: 'gemini', integrationStatus: 'not_connected', integrationDetails: { mcp: 'missing', skills: 'current' } },
    { id: 'pack-only-client', integrationStatus: 'connected', integrationDetails: { mcp: 'current' } }
  ];
  const installer = [
    { id: 'claude-code', state: 'update_available', componentStates: [{ component: 'mcp', state: 'current' },
      { component: 'skills', state: 'conflict', message: 'C:/Users/someone/.claude/skills/flreview has no receipt' },
      { component: 'hooks', state: 'current' }] },
    { id: 'gemini-cli', state: 'not_connected', componentStates: [{ component: 'mcp', state: 'missing' }] }
  ];
  const root = mkdtempSync(join(tmpdir(), 'fuli-installer-compare-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const variables = [];
  const report = await runInstallerShadow({ manifestPath: join(root, 'fuli-installer.json'),
    context: { dataDir: root, nodePath: 'node', mcpServerPath: join(root, 'src', 'mcp-server.js'),
      runtimeConfigPath: join(root, 'graph-runtime.json'), sessionSkillPath: join(root, 'skills', 'capturing-session-knowledge') },
    installer: { status: async (values) => { variables.push(values); return { status: 'available', clients: installer }; } },
    discover: () => [], inspect: () => fuli });
  assert.equal(variables[0].claudeHook, join(root, 'src', 'agents', 'claude-code', 'lifecycle-hook.js'));
  assert.equal(variables[0].skillsDir, join(root, 'skills'));
  assert.deepEqual(report.clients, [
    { id: 'claude-code', installerId: 'claude-code', fuli: 'connected', installer: 'update_available', agree: false,
      components: [{ component: 'skills', fuli: 'current', installer: 'conflict' }] },
    { id: 'gemini', installerId: 'gemini-cli', fuli: 'not_connected', installer: 'not_connected', agree: true,
      components: [{ component: 'skills', fuli: 'current', installer: null }] }
  ]);
});

test('the doctor reads the last comparison and never waits for a new one', async () => {
  let runs = 0;
  let clock = 0;
  let finish;
  const shadow = createInstallerShadow({ now: () => clock, run: () => {
    runs += 1;
    return new Promise((resolve) => { finish = resolve; });
  } });
  assert.deepEqual(shadow.latest(), { status: 'pending' });
  assert.deepEqual(shadow.latest(), { status: 'pending' }, 'a comparison in progress is not started twice');
  await new Promise(setImmediate);
  finish({ status: 'available', clients: [] });
  await new Promise(setImmediate);
  assert.deepEqual(shadow.latest(), { status: 'available', clients: [], checkedAt: new Date(0).toISOString() });
  assert.equal(runs, 1);
  clock = 10 * 60_000;
  shadow.latest();
  await new Promise(setImmediate);
  finish({ status: 'unavailable', reason: 'offline' });
  await new Promise(setImmediate);
  assert.equal(shadow.latest().status, 'unavailable');
  assert.equal(runs, 2, 'a stale comparison is refreshed');
});

test('the real installer\'s status beside FULI\'s own inspection of clients FULI set up', async (t) => {
  const executable = await realAgentKitExecutable('agent-installer');
  if (!executable) { t.skip('the pinned installer cannot be downloaded here'); return; }
  const { home, env } = isolateHomeEnvironment(t);
  const root = mkdtempSync(join(tmpdir(), 'fuli-installer-shadow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  mkdirSync(join(root, 'extensions'));
  const skills = join(REPOSITORY, 'skills');
  const context = { dataDir, nodePath: process.execPath, mcpServerPath: join(REPOSITORY, 'src', 'mcp-server.js'),
    runtimeConfigPath: join(dataDir, 'graph-runtime.json'), platform: process.platform,
    sessionSkillPath: join(skills, 'capturing-session-knowledge'), projectSkillPath: join(skills, 'grilling-project'),
    reviewSkillPath: join(skills, 'flreview'), operationSkillPath: join(skills, 'operating-fuli'),
    sessionCommandSkillPath: join(skills, 'fuli') };
  const discover = (options) => discoverAgents({ ...options, platform: process.platform, env, homeDir: home,
    commandExists: () => false, commandVersion: () => null });
  // FULI's own writers set up these clients in the temporary home.
  const connected = ['claude-code', 'codex', 'cursor', 'gemini', 'claude-desktop'];
  for (const agent of discover({ includeUnavailable: true, dataDir }).filter(({ id }) => connected.includes(id))) {
    mkdirSync(dirname(agent.configPath), { recursive: true });
    const result = await installAgent(agent, context, { ...context, backupDir: join(dataDir, 'backups', 'agents') });
    assert.equal(result.status === 'partial' ? result.message : result.status, 'connected', agent.id);
  }
  const manifestPath = join(dataDir, 'agent-kits', 'fuli-installer.json');
  const installer = createClientInstallerPort({ manifestPath, extensionsDir: join(root, 'extensions'),
    executables: agentKitExecutables({ nativeRuntimeDir: join(dataDir, 'native-runtime'), env: { FULI_AGENT_INSTALLER: executable } }) });
  const report = await runInstallerShadow({ installer, manifestPath, context, discover, inspect: inspectAgentInstallations });
  assert.equal(report.status, 'available', report.reason);
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).product, 'fuli');
  const summary = Object.fromEntries(report.clients.map(({ id, fuli, installer: state, components }) =>
    [id, [fuli, state, components.map(({ component, fuli: own, installer: theirs }) => `${component}:${own}/${theirs}`)]]));
  t.diagnostic(`installer shadow: ${JSON.stringify(summary)}`);
  // Clients FULI never set up, and the MCP-only clients it did, agree.
  for (const id of ['kiro', 'qwen-code', 'opencode']) assert.deepEqual(summary[id], ['not_connected', 'not_connected', []], id);
  for (const id of ['claude-desktop', 'gemini']) assert.deepEqual(summary[id], ['connected', 'connected', []], id);
  // Clients with hooks: FULI says connected; the installer writes hook
  // commands in its own quoting (and PowerShell for Codex on Windows), so it
  // reads FULI's hooks as outdated. Nothing else differs: MCP, Skills (adopted
  // without a receipt) and the Codex instruction block agree.
  for (const id of ['claude-code', 'codex', 'cursor']) {
    assert.equal(summary[id][0], 'connected', id);
    assert.deepEqual(summary[id][2].filter((component) => !component.startsWith('hooks:')), [], id);
  }
});
