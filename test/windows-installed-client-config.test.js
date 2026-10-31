// An installed Windows copy's client configurations name the stable launcher at
// its installation root (rec#11 D-80), so update and rollback leave them current.
// Synthetic installation, data directory and client home only.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { installedWindowsFixture } from './fixtures/windows-installation.js';
import { updateWindowsInstallation } from '../src/desktop/windows-update.js';
import { inspectAgentInstallations } from '../src/setup/agent-installation-status.js';
import { connectAgent, discoverAgents } from '../src/setup/agents.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { createClientConnectionObserver } from '../src/system/client-connection-status.js';
import { createDoctor } from '../src/system/doctor.js';

// The context fuli setup, the console's client installer and its observation build from setup paths.
const clientContext = paths => ({ dataDir: paths.dataDir, nodePath: paths.clientNodePath, mcpServerPath: paths.mcpServerPath,
  runtimeConfigPath: paths.graphRuntimeConfigPath, sessionSkillPath: paths.sessionSkillPath, projectSkillPath: paths.projectSkillPath,
  reviewSkillPath: paths.reviewSkillPath, operationSkillPath: paths.operationSkillPath, sessionCommandSkillPath: paths.sessionCommandSkillPath });

function clients(f) {
  const homeDir = join(f.root, 'home');
  mkdirSync(homeDir, { recursive: true });
  const discover = (options = {}) => discoverAgents({ env: {}, homeDir, dataDir: f.current.dataDir, ...options,
    commandExists: () => true, commandVersion: () => '2.1.4' });
  const agents = discover().filter(agent => agent.available && !agent.manualOnly);
  // Every client a FULI connection writes a node command, script or plugin file into.
  assert.ok(['claude-code', 'codex', 'cursor', 'opencode'].every(id => agents.some(agent => agent.id === id)));
  const files = () => agents.flatMap(agent => [agent.configPath, agent.settingsPath, agent.hooksPath, agent.pluginPath])
    .filter(Boolean).map(path => { try { return readFileSync(path, 'utf8'); } catch { return ''; } }).join('\n');
  return { agents, discover, files, connect: context => agents.forEach(agent => connectAgent(agent, context)),
    inspect: context => inspectAgentInstallations(agents, context, { skillCurrent: () => true, bootstrapCurrent: () => true })
      .map(({ id, integrationDetails: { skills, ...details } }) => [id, details]) };
}

const allCurrent = inspected => inspected.every(([, details]) => Object.values(details).every(value => value === 'current'));

test('installed clients run the launcher with package-relative scripts and stay current across an update', async t => {
  const f = installedWindowsFixture(t);
  const paths = resolveSetupPaths({ platform: 'win32', packageRoot: f.current.packageRoot, env: f.env });
  assert.equal(paths.clientNodePath, join(f.current.installRoot, 'FuliNode.exe'));
  assert.equal(paths.mcpServerPath, join('src', 'mcp-server.js'));
  const c = clients(f);
  c.connect(clientContext(paths));
  const written = c.files();
  assert.ok(written.includes(JSON.stringify(paths.clientNodePath).slice(1, -1)), 'configurations name the launcher');
  assert.doesNotMatch(written, /versions/, 'no configuration names a version folder');
  assert.ok(allCurrent(c.inspect(clientContext(paths))));

  const next = await updateWindowsInstallation(f.options, f.deps);
  const updated = resolveSetupPaths({ platform: 'win32', packageRoot: next.packageRoot, env: f.env });
  const named = ({ nodePath, mcpServerPath, runtimeConfigPath }) => ({ nodePath, mcpServerPath, runtimeConfigPath });
  assert.deepEqual(named(clientContext(updated)), named(clientContext(paths)), 'the update changes nothing a client configuration names');
  assert.ok(allCurrent(c.inspect(clientContext(updated))));
});

test('absolute version paths an earlier FULI wrote are outdated, and reconnection migrates them', async t => {
  const f = installedWindowsFixture(t);
  const paths = resolveSetupPaths({ platform: 'win32', packageRoot: f.current.packageRoot, env: f.env });
  const c = clients(f);
  // What setup wrote before the launcher: the slot's own node and scripts.
  c.connect({ ...clientContext(paths), nodePath: join(f.current.packageRoot, 'runtime', 'node', 'node.exe'),
    mcpServerPath: join(f.current.packageRoot, 'src', 'mcp-server.js') });
  assert.ok(c.inspect(clientContext(paths)).every(([, details]) => details.mcp === 'outdated'));
  // Skills are copies checked on their own; only the MCP entry and hooks are under test.
  const observer = createClientConnectionObserver({ discover: c.discover, context: clientContext(paths),
    historyPath: join(f.root, 'client-history.json'),
    inspect: (agents, context, readers) => inspectAgentInstallations(agents, context, { ...readers, skillCurrent: () => true }) });
  const doctor = createDoctor({ observeClients: () => observer.observe(), liveProcesses: () => [],
    latestVersion: () => null, lastUpdate: () => null });
  const outdated = async () => (await doctor.check()).items.filter(item => item.kind === 'client_outdated').map(item => item.data.clientId);
  assert.deepEqual((await outdated()).sort(), c.agents.map(agent => agent.id).sort());
  c.connect(clientContext(paths));
  assert.deepEqual(await outdated(), []);
  assert.ok(allCurrent(c.inspect(clientContext(paths))));
});

test('without the launcher (npm, or an installation before it) clients keep this Node and absolute paths', t => {
  const f = installedWindowsFixture(t);
  rmSync(join(f.current.installRoot, 'FuliNode.exe'));
  const installed = resolveSetupPaths({ platform: 'win32', packageRoot: f.current.packageRoot, env: f.env });
  assert.equal(installed.clientNodePath, process.execPath);
  assert.equal(installed.mcpServerPath, join(f.current.packageRoot, 'src', 'mcp-server.js'));
  // A package that is not installed (the candidate it came from) has no installation launcher either.
  const candidate = resolveSetupPaths({ platform: 'win32', packageRoot: f.source, env: f.env });
  assert.equal(candidate.clientNodePath, process.execPath);
  assert.equal(candidate.mcpServerPath, join(f.source, 'src', 'mcp-server.js'));
});
