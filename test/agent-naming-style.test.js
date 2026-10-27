import assert from 'node:assert/strict';
import test from 'node:test';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { DEFAULT_RUNTIME_SETTINGS, normalizeRuntimeSettings, readRuntimeSettings } from '../src/system/runtime-settings.js';
import { describeSettings } from '../src/system/settings-guide.js';
import { createSystemService } from '../src/system/system-service.js';

// Agent 取名风格: the person's saved style reaches the recruiting Agent only
// when it asks, right before it proposes a new Agent's name. Synthetic values only.
const PATHS = Object.freeze({
  dataDir: '/data',
  graphRuntimeConfigPath: '/data/graph-runtime.json',
  graphRuntimeStatePath: '/data/graph-runtime-state.json',
  runtimeSettingsPath: '/data/runtime-settings.json',
  mcpServerPath: '/package/src/mcp-server.js'
});
const STYLE = '用两个字的植物名，例如青禾、松风';

function settingsService() {
  let saved = structuredClone(DEFAULT_RUNTIME_SETTINGS);
  const state = { version: 4, pid: 27, port: 2727, runtimeSettings: structuredClone(DEFAULT_RUNTIME_SETTINGS) };
  const service = createSystemService({
    paths: PATHS, packageRoot: '/package', activePort: 2727, activeLan: false,
    settingsApplier: { status: () => null, prepare: async () => assert.fail('a naming style needs no restart') },
    readJson: (path, fallback) => path === PATHS.graphRuntimeStatePath ? state
      : path === PATHS.graphRuntimeConfigPath ? { personal: { providerUrl: 'http://127.0.0.1:8787' }, workspaces: [] } : fallback,
    readSettings: () => saved,
    writeSettings: (_path, value) => { saved = structuredClone(value); return saved; },
    resourceMonitor: {}, runtimeBroker: {}, versionChecker: {}
  });
  return { service, saved: () => saved };
}

test('the person sets, edits and clears the naming style without a restart', async () => {
  const { service, saved } = settingsService();
  assert.equal(service.getSettings().configured.agentNamingStyle, '');

  const set = await service.updateSettings({ ...saved(), agentNamingStyle: `  ${STYLE}\n` });
  assert.equal(set.restartRequired, false);
  assert.equal(saved().agentNamingStyle, STYLE);
  assert.equal(service.getSettings().configured.agentNamingStyle, STYLE);

  await service.updateSettings({ ...saved(), agentNamingStyle: '像北欧神话里的名字' });
  assert.equal(saved().agentNamingStyle, '像北欧神话里的名字');

  await service.updateSettings({ ...saved(), agentNamingStyle: '' });
  assert.equal(saved().agentNamingStyle, '');
});

test('about 100 characters is a suggestion; only a pasted essay or control characters are refused', () => {
  assert.equal(normalizeRuntimeSettings({ agentNamingStyle: '名'.repeat(300) }).agentNamingStyle.length, 300);
  assert.throws(() => normalizeRuntimeSettings({ agentNamingStyle: '名'.repeat(501) }), /at most 500 characters/);
  assert.throws(() => normalizeRuntimeSettings({ agentNamingStyle: 'a\u0000b' }), /plain text/);
  assert.throws(() => normalizeRuntimeSettings({ agentNamingStyle: 7 }), /must be a string/);
  // Settings saved before the style existed read as no style.
  const { agentNamingStyle: _absent, ...older } = DEFAULT_RUNTIME_SETTINGS;
  assert.equal(readRuntimeSettings('/data/runtime-settings.json', { read: () => older }).agentNamingStyle, '');
});

test('the recruiting Agent reads the saved style, or null for the default generated names', async () => {
  let style = STYLE;
  const app = { agentNamingStyle: () => style };
  const answer = await callAgentTool(app, 'get_agent_naming_style', {});
  assert.equal(answer.style, STYLE);
  assert.match(answer.guidance, /agent_name_taken/);
  assert.match(answer.guidance, /same style/);
  assert.match(answer.guidance, /tell the person/);
  assert.match(answer.guidance, /Existing Agents keep their names/);

  style = '';
  const none = await callAgentTool(app, 'get_agent_naming_style', {});
  assert.equal(none.style, null);
  assert.match(none.guidance, /omit displayName/);

  await assert.rejects(async () => callAgentTool({}, 'get_agent_naming_style', {}), /local installation/);
});

test('each schema that creates an Agent points its displayName at the style, which only the person changes', () => {
  const tools = Object.fromEntries(listAgentTools().map((tool) => [tool.name, tool]));
  const displayNames = [
    tools.upsert_project_agent.inputSchema.properties.profile.properties.displayName,
    tools.submit_project_agent_task.inputSchema.properties.recruitmentProfile.properties.displayName,
    tools.coordinate_project_agent_task.inputSchema.properties.recruitmentProfile.properties.displayName,
  ];
  for (const displayName of displayNames) assert.match(displayName.description, /get_agent_naming_style/);

  const catalog = agentInterfaceCatalog();
  const settingsWrite = catalog.uiMutationParity.find(({ route }) => route === 'PUT /api/system/settings');
  assert.equal(settingsWrite.access, 'local_user_only');
  assert.ok(catalog.readWorkflows.some(({ toolNames }) => toolNames.includes('get_agent_naming_style')));

  const row = describeSettings({ settings: { ...DEFAULT_RUNTIME_SETTINGS, agentNamingStyle: STYLE },
    capturePolicy: {}, consoleUrl: 'http://127.0.0.1:2727' }).settings.find(({ key }) => key === 'agentNamingStyle');
  assert.equal(row.value, STYLE);
  assert.equal(row.changedBy, 'person');
  assert.equal(row.settingsUrl, 'http://127.0.0.1:2727/settings?setting=agentNamingStyle');
});
