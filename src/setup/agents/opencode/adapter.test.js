// OpenCode setup through its descriptor pack and the 'opencode-plugin' writer
// (rec#11 D-63). Every write goes to a synthetic temporary HOME; no real
// OpenCode configuration, FULI data directory or OpenCode process is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentAdapter } from '../registry.js';
import { inspectAgentInstallations } from '../../agent-installation-status.js';
import { previewClientConfiguration } from '../config-preview.js';
import { loadClientDescriptorPacks } from '../descriptor-packs.js';

const adapter = agentAdapter('opencode');
const pack = loadClientDescriptorPacks().find(({ id }) => id === 'opencode');
const CONTEXT = Object.freeze({ nodePath: '/runtime/node', mcpServerPath: '/pkg/src/mcp-server.js',
  runtimeConfigPath: '/data/graph-runtime.json' });

function home(t) {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'fuli-opencode-'));
  t.after(() => rmSync(homeDir, { recursive: true, force: true }));
  return homeDir;
}
function detect(homeDir, { version = '2.1.4', env = {}, fileExists = existsSync, commandExists = () => true } = {}) {
  return adapter.detect({ homeDir, env, pathApi: path, fileExists, commandExists, commandVersion: () => version });
}
const lifecycle = (agent) => inspectAgentInstallations([agent], CONTEXT, { skillCurrent: () => true })[0].integrationDetails;

test('OpenCode 2.x: setup writes the MCP entry and the plugin, keeps JSONC comments, and disconnect removes both', (t) => {
  const homeDir = home(t);
  const configPath = path.join(homeDir, '.config/opencode/opencode.jsonc');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, '{\n // user theme\n "theme":"dark",\n "mcp": {"other":{"type":"local","command":["other"]}},\n}');
  const agent = detect(homeDir);
  assert.equal(agent.configPath, configPath);
  assert.equal(agent.pluginPath, path.join(homeDir, '.config/opencode/plugins/fuli/index.js'));
  assert.equal(agent.skillPath, path.join(homeDir, '.config/opencode/skills/capturing-session-knowledge'));
  assert.equal(agent.clientVersion, '2.1.4');

  const connected = adapter.connect(agent, CONTEXT);
  assert.equal(connected.status, 'connected');
  assert.equal(connected.nextSteps, undefined);
  const config = readFileSync(configPath, 'utf8');
  assert.ok(config.includes('// user theme'));
  assert.match(config, /"other"/);
  assert.match(config, /"--source-application",\s*"opencode"/);
  const plugin = readFileSync(agent.pluginPath, 'utf8');
  const packaged = path.join(path.dirname(CONTEXT.mcpServerPath), 'agents', 'opencode');
  assert.ok(plugin.includes(JSON.stringify(pathToFileURL(path.join(packaged, 'plugin.js')).href)), 'imports the packaged plugin');
  assert.ok(plugin.includes(JSON.stringify(path.join(packaged, 'lifecycle-hook.js'))));
  assert.ok(plugin.includes(JSON.stringify(CONTEXT.runtimeConfigPath)));
  assert.match(plugin, /"events": \[\s*"prompt",\s*"execution\.succeeded"\s*\]/);
  assert.match(plugin, /"timeoutMs": 10000/, 'the hook deadline leaves room inside the pack timeout');
  assert.deepEqual({ mcp: lifecycle(agent).mcp, lifecycleHooks: lifecycle(agent).lifecycleHooks },
    { mcp: 'current', lifecycleHooks: 'current' });
  assert.equal(adapter.connect(agent, CONTEXT).restartRequired, false, 'a second connect writes nothing');

  assert.equal(adapter.disconnect(agent).status, 'disconnected');
  assert.equal(existsSync(agent.pluginPath), false);
  assert.equal(existsSync(path.dirname(agent.pluginPath)), false);
  const remaining = readFileSync(configPath, 'utf8');
  assert.ok(remaining.includes('// user theme'));
  assert.doesNotMatch(remaining, /"fuli"/);
  assert.equal(adapter.disconnect(agent).status, 'not_connected');
});

test('an OpenCode MCP entry FULI wrote as `other` is reported outdated and rewritten as `opencode`, keeping its profile', (t) => {
  const homeDir = home(t);
  const agent = detect(homeDir);
  mkdirSync(path.dirname(agent.configPath), { recursive: true });
  writeFileSync(agent.configPath, JSON.stringify({ mcp: { fuli: { type: 'local', command: [CONTEXT.nodePath, CONTEXT.mcpServerPath,
    '--runtime-config', CONTEXT.runtimeConfigPath, '--source-application', 'other', '--tool-profile', 'full'], enabled: true } } }));
  assert.equal(lifecycle(agent).mcp, 'outdated');
  adapter.connect(agent, CONTEXT);
  const { command } = JSON.parse(readFileSync(agent.configPath, 'utf8')).mcp.fuli;
  assert.deepEqual(command.slice(-4), ['--source-application', 'opencode', '--tool-profile', 'full']);
  assert.equal(lifecycle(agent).mcp, 'current');
});

test('uninstall removes the plugin even when the OpenCode configuration cannot be parsed', (t) => {
  const homeDir = home(t);
  const agent = detect(homeDir);
  adapter.connect(agent, CONTEXT);
  writeFileSync(agent.configPath, '{ "mcp": [ }');
  assert.throws(() => adapter.disconnect(agent));
  assert.equal(existsSync(agent.pluginPath), false, 'no FULI code keeps loading into OpenCode');
  assert.equal(readFileSync(agent.configPath, 'utf8'), '{ "mcp": [ }', 'the unparseable file is left as it was');
});

test('OpenCode 1.x is detected and refused: the MCP entry is connected, the V2 plugin is not installed', (t) => {
  const homeDir = home(t);
  const agent = detect(homeDir, { version: '1.19.4' });
  const connected = adapter.connect(agent, CONTEXT);
  assert.equal(connected.status, 'connected');
  assert.match(connected.nextSteps[0], /OpenCode 1\.19\.4 found: FULI's per-prompt plugin needs OpenCode 2\.x/);
  assert.equal(existsSync(agent.pluginPath), false);
  assert.match(readFileSync(agent.configPath, 'utf8'), /"fuli"/);
  assert.equal(lifecycle(agent).lifecycleHooks, undefined, 'no plugin is expected for V1');
  assert.equal(lifecycle(agent).mcp, 'current');

  // A downgrade from 2.x takes FULI's plugin away instead of leaving V2 code for V1.
  adapter.connect(detect(homeDir), CONTEXT);
  assert.equal(existsSync(agent.pluginPath), true);
  adapter.connect(agent, CONTEXT);
  assert.equal(existsSync(agent.pluginPath), false);
});

test('an unknown OpenCode version installs no new plugin but keeps an installed one current', (t) => {
  const homeDir = home(t);
  const unknown = detect(homeDir, { version: null });
  const connected = adapter.connect(unknown, CONTEXT);
  assert.match(connected.nextSteps[0], /version could not be read/);
  assert.equal(existsSync(unknown.pluginPath), false);
  adapter.connect(detect(homeDir), CONTEXT);
  const moved = { ...CONTEXT, runtimeConfigPath: '/elsewhere/graph-runtime.json' };
  assert.equal(lifecycle(unknown).lifecycleHooks, 'current');
  adapter.connect(unknown, moved);
  assert.ok(readFileSync(unknown.pluginPath, 'utf8').includes('/elsewhere/graph-runtime.json'));
});

test('a plugin FULI did not write is never overwritten or removed', (t) => {
  const homeDir = home(t);
  const agent = detect(homeDir);
  mkdirSync(path.dirname(agent.pluginPath), { recursive: true });
  writeFileSync(agent.pluginPath, 'export default { id: "someone-else", setup() {} };\n');
  assert.throws(() => adapter.connect(agent, CONTEXT), /was not written by FULI/);
  assert.equal(existsSync(agent.configPath), false, 'nothing was written');
  adapter.disconnect(agent);
  assert.match(readFileSync(agent.pluginPath, 'utf8'), /someone-else/);
});

test('XDG_CONFIG_HOME moves the config, plugin and Skills together', (t) => {
  const homeDir = home(t);
  const xdg = path.join(homeDir, 'xdg');
  const agent = detect(homeDir, { env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(agent.configPath, path.join(xdg, 'opencode', 'opencode.json'));
  assert.equal(agent.pluginPath, path.join(xdg, 'opencode', 'plugins', 'fuli', 'index.js'));
  assert.equal(agent.skillPath, path.join(xdg, 'opencode', 'skills', 'capturing-session-knowledge'));
});

test('layered OpenCode configuration gets the documented manual setup instead of a claimed connection', (t) => {
  const homeDir = home(t);
  const manual = detect(homeDir, { env: { OPENCODE_CONFIG: '/custom/config' } });
  assert.equal(manual.manualOnly, true);
  assert.equal(manual.manualUrl, 'https://opencode.ai/docs/config/');
  assert.throws(() => adapter.connect(manual, CONTEXT), /manual/);
  assert.equal(existsSync(manual.pluginPath), false);
  assert.equal(detect(homeDir, { fileExists: () => true }).manualOnly, true, 'opencode.json beside opencode.jsonc');
});

test('OpenCode discovers a Windows JSONC config without accessing the host filesystem', () => {
  const configPath = String.raw`C:\Users\Tester\.config\opencode\opencode.jsonc`;
  const agent = adapter.detect({ homeDir: String.raw`C:\Users\Tester`, env: {}, pathApi: path.win32,
    commandExists: () => false, commandVersion: () => null, fileExists: (file) => file === configPath });
  assert.equal(agent.configPath, configPath);
  assert.equal(agent.pluginPath, String.raw`C:\Users\Tester\.config\opencode\plugins\fuli\index.js`);
  assert.equal(agent.available, true);
  assert.notEqual(agent.manualOnly, true);
});

test('a client pack update previews the plugin change in memory only', (t) => {
  const homeDir = home(t);
  adapter.connect(detect(homeDir), CONTEXT);
  // `fuli clients update` reads no client version: an installed plugin is kept current.
  const target = adapter.detect({ homeDir, env: {}, pathApi: path, fileExists: existsSync, commandExists: () => false });
  const before = readFileSync(target.pluginPath, 'utf8');
  const changed = { ...pack, lifecycleHooks: { ...pack.lifecycleHooks, timeoutSec: 20 } };
  const changes = previewClientConfiguration(changed, target, CONTEXT);
  assert.deepEqual(changes.map(({ path: file }) => file), [target.pluginPath]);
  assert.match(changes[0].after, /"timeoutMs": 18000/);
  assert.equal(readFileSync(target.pluginPath, 'utf8'), before, 'the preview wrote nothing');
});
