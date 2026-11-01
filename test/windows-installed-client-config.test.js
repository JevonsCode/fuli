// An installed Windows copy's client configurations name the stable launcher at
// its installation root (rec#11 D-80), so update and rollback leave them current.
// Synthetic installation, data directory and client home only; agent-installer
// is the real pinned executable, run against that home.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { installedWindowsFixture } from './fixtures/windows-installation.js';
import { updateWindowsInstallation } from '../src/desktop/windows-update.js';
import { detectClients } from '../src/agent-kits/client-detection.js';
import { createClientInstallerPort } from '../src/agent-kits/client-installer.js';
import { agentKitExecutables } from '../src/agent-kits/executables.js';
import { agentTargets, connectAgent } from '../src/setup/agents.js';
import { installAgent } from '../src/setup/install-agent.js';
import { integrationContext } from '../src/setup/integration-context.js';
import { resolveSetupPaths } from '../src/setup/paths.js';
import { createClientConnectionObserver } from '../src/system/client-connection-status.js';
import { createDoctor } from '../src/system/doctor.js';
import { isolateHomeEnvironment, realAgentKitExecutable } from '../test-support/agent-kit-binaries.js';

// The context fuli setup, the console's client installer and its observation build from setup paths.
const clientContext = paths => integrationContext(paths);
// Every client a FULI connection writes a node command, script or plugin file into.
const WRITTEN = ['claude-code', 'codex', 'cursor', 'opencode'];

async function clients(t, f) {
  const executable = await realAgentKitExecutable('agent-installer');
  if (!executable) return null;
  const { home: homeDir, env } = isolateHomeEnvironment(t);
  mkdirSync(homeDir, { recursive: true });
  const targets = () => agentTargets({ env, homeDir, dataDir: f.current.dataDir, commandVersion: () => '2.1.4' });
  const agents = targets().filter(agent => WRITTEN.includes(agent.id));
  const files = () => agents.flatMap(agent => [agent.configPath, agent.settingsPath, agent.hooksPath, agent.pluginPath])
    .filter(Boolean).map(path => { try { return readFileSync(path, 'utf8'); } catch { return ''; } }).join(String.fromCharCode(10));
  const installer = (context) => createClientInstallerPort({ manifestPath: join(f.root, 'agent-kits', 'fuli-installer.json'), context,
    targets, extensionsDir: join(f.root, 'extensions'),
    executables: agentKitExecutables({ nativeRuntimeDir: join(f.root, 'native-runtime'), env: { FULI_AGENT_INSTALLER: executable } }) });
  // Skills are copies checked on their own; only the MCP entry, hooks, plugin and instructions are under test.
  const inspect = async context => (await detectClients(installer(context))).clients.filter(({ id }) => WRITTEN.includes(id))
    .map(({ id, components: { skills, ...details } }) => [id, details]);
  return { agents, targets, files, installer, inspect, connect: context => agents.forEach(agent => connectAgent(agent, context)) };
}

const allCurrent = inspected => inspected.length === WRITTEN.length
  && inspected.every(([, details]) => Object.values(details).every(value => value === 'current'));

test('installed clients run the launcher with package-relative scripts and stay current across an update', async t => {
  const f = installedWindowsFixture(t);
  const paths = resolveSetupPaths({ platform: 'win32', packageRoot: f.current.packageRoot, env: f.env });
  assert.equal(paths.clientNodePath, join(f.current.installRoot, 'FuliNode.exe'));
  assert.equal(paths.mcpServerPath, join('src', 'mcp-server.js'));
  const c = await clients(t, f);
  if (!c) { t.skip('the pinned installer cannot be downloaded here'); return; }
  c.connect(clientContext(paths));
  const written = c.files();
  assert.ok(written.includes(JSON.stringify(paths.clientNodePath).slice(1, -1)), 'configurations name the launcher');
  assert.doesNotMatch(written, /versions/, 'no configuration names a version folder');
  assert.ok(allCurrent(await c.inspect(clientContext(paths))), JSON.stringify(await c.inspect(clientContext(paths))));

  const next = await updateWindowsInstallation(f.options, f.deps);
  const updated = resolveSetupPaths({ platform: 'win32', packageRoot: next.packageRoot, env: f.env });
  const named = ({ nodePath, mcpServerPath, runtimeConfigPath }) => ({ nodePath, mcpServerPath, runtimeConfigPath });
  assert.deepEqual(named(clientContext(updated)), named(clientContext(paths)), 'the update changes nothing a client configuration names');
  assert.ok(allCurrent(await c.inspect(clientContext(updated))));
});

test('absolute version paths an earlier FULI wrote are outdated, and reconnection migrates them', async t => {
  const f = installedWindowsFixture(t);
  const paths = resolveSetupPaths({ platform: 'win32', packageRoot: f.current.packageRoot, env: f.env });
  const c = await clients(t, f);
  if (!c) { t.skip('the pinned installer cannot be downloaded here'); return; }
  // What setup wrote before the launcher: the slot's own node and scripts.
  c.connect({ ...clientContext(paths), nodePath: join(f.current.packageRoot, 'runtime', 'node', 'node.exe'),
    mcpServerPath: join(f.current.packageRoot, 'src', 'mcp-server.js') });
  assert.ok((await c.inspect(clientContext(paths))).every(([, details]) => details.mcp === 'outdated'));
  const observer = createClientConnectionObserver({ installer: c.installer(clientContext(paths)), targets: c.targets,
    customClients: { removable: () => new Set() }, historyPath: join(f.root, 'client-history.json') });
  const doctor = createDoctor({ observeClients: () => observer.observe(), liveProcesses: () => [],
    latestVersion: () => null, lastUpdate: () => null });
  const outdated = async () => (await doctor.check()).items.filter(item => item.kind === 'client_outdated').map(item => item.data.clientId);
  assert.deepEqual((await outdated()).filter(id => WRITTEN.includes(id)).sort(), [...WRITTEN].sort());
  // A reconnection is a whole setup, Skills included (synthetic Skill copies in this slot).
  for (const name of ['capturing-session-knowledge', 'grilling-project', 'flreview', 'operating-fuli', 'fuli']) {
    mkdirSync(join(f.current.packageRoot, 'skills', name), { recursive: true });
    writeFileSync(join(f.current.packageRoot, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
  for (const agent of c.agents) {
    await installAgent(agent, clientContext(paths), { ...clientContext(paths), backupDir: join(f.root, 'backups') });
  }
  assert.deepEqual((await outdated()).filter(id => WRITTEN.includes(id)), []);
  assert.ok(allCurrent(await c.inspect(clientContext(paths))));
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
