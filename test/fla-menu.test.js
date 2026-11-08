import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PromptListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { claudeFlaMenuPrompt } from '../src/agents/claude-code/fla-menu-command.js';
import { employeeAgentId, employeeCapability } from '../src/employees/manifest.js';
import { flaCandidates, roleCandidates } from '../src/graphiti/fla-picker.js';
import { flaMenuEntries, menuLanguage, occupationNameMap, withMenuNames } from '../src/graphiti/fla-menu.js';
import { registerFlaMenuPrompts } from '../src/mcp/fla-menu-prompts.js';

// 11-08: the person's FLAs in an Agent client's / menu (/fla). Synthetic
// roster only; no real data, client, port or model.

const SPACE = 'synthetic-space';
const PROJECTS = [['project-a', 'Alpha'], ['project-b', 'Beta'], ['project-c', 'Gamma']]
  .map(([id, name]) => ({ project_id: id, scope_type: 'registered', profile: { name } }));
const CATALOG = { items: [
  { key: 'lead', name_zh: '负责人', name_en: 'Lead' }, { key: 'engineering', name_zh: '工程', name_en: 'Engineering' },
  { key: 'testing', name_zh: '测试', name_en: 'Testing' }, { key: 'project_manager', name_zh: '项目经理', name_en: 'Project manager' }
] };

function fla(agentId, name, role, projectId, { status = 'active', clients = ['codex', 'claude_code'], label = role } = {}) {
  return { agent_id: agentId, personal_space_id: SPACE, personal_project_id: null, updated_at: '2026-11-01T00:00:00Z',
    occupation: { role }, assignments: projectId ? [{ personal_project_id: projectId, status: 'active' }] : [],
    profile: { name: label, display_name: name, status, allowed_clients: clients, capabilities: [], agent_type: 'durable' } };
}

function role(id, name, occupation) {
  return { agent_id: employeeAgentId(id), personal_space_id: SPACE, occupation: { role: occupation }, assignments: [],
    profile: { name, status: 'active', allowed_clients: ['codex', 'claude_code'], capabilities: [employeeCapability(id)], agent_type: 'employee' } };
}

const ROSTER = [
  fla('ada', 'Ada Lead', 'lead', 'project-a', { label: 'Alpha 负责人' }),
  fla('jamie', 'Jamie Ash', 'engineering', 'project-b'),
  fla('jamie-c', 'Jamie Ash', 'testing', 'project-c'),
  fla('lin', '小林', 'testing', 'project-a'),
  fla('gil', 'Gil Global', 'engineering', null),
  fla('cody', 'Cody Only', 'engineering', 'project-a', { clients: ['codex'] }),
  fla('gone', 'Gone Wu', 'engineering', 'project-a', { status: 'archived' }),
  role('jefa', 'Jefa', 'project_manager')
];

const candidates = (roster = ROSTER) => [...flaCandidates(roster, PROJECTS, SPACE), ...roleCandidates(roster, PROJECTS, SPACE, null)];
// The /fla name task entry matches for each candidate (its last alias).
const menuNames = list => withMenuNames(list).map(item => item.aliases.at(-1));
const byName = entries => Object.fromEntries(entries.map(entry => [entry.name, entry]));

test('each FLA placement and role gets one /fla name; a shared name adds its project', () => {
  const names = menuNames(candidates()).sort();
  assert.deepEqual(names, ['fla-ada-lead', 'fla-cody-only', 'fla-gil-global', 'fla-gone-wu', 'fla-jamie-ash-beta',
    'fla-jamie-ash-gamma', 'fla-jefa', 'fla-小林'].sort());
  // The same roster gives the same names whatever order it is read in.
  assert.deepEqual(menuNames(candidates([...ROSTER].reverse())).sort(), names);
  // Two FLAs with one name in one project are numbered.
  const twins = [fla('t1', 'Sam', 'testing', 'project-a'), fla('t2', 'Sam', 'testing', 'project-a')];
  assert.deepEqual(menuNames(candidates(twins)).sort(), ['fla-sam-alpha', 'fla-sam-alpha-2']);
});

test('entries list FLAs this client may continue, as name — project — role in the console language', () => {
  const zh = byName(flaMenuEntries(candidates(), { sourceApplication: 'claude_code', language: 'zh-CN',
    occupationNames: occupationNameMap(CATALOG) }));
  assert.deepEqual(Object.keys(zh).sort(), ['fla-ada-lead', 'fla-gil-global', 'fla-jamie-ash-beta', 'fla-jamie-ash-gamma',
    'fla-jefa', 'fla-小林'].sort(), 'a Codex-only or dismissed FLA is not listed');
  assert.equal(zh['fla-ada-lead'].description, 'Ada Lead — Alpha — 负责人');
  assert.equal(zh['fla-gil-global'].description, 'Gil Global — 全局 — 工程');
  assert.equal(zh['fla-jefa'].description, 'Jefa — 项目经理');
  assert.equal(zh['fla-小林'].text, '#FLA 小林');
  // A shared name expands to the menu name, which names exactly one FLA.
  assert.equal(zh['fla-jamie-ash-gamma'].text, '#FLA fla-jamie-ash-gamma');
  const en = byName(flaMenuEntries(candidates(), { sourceApplication: 'claude_code', language: 'en-US',
    occupationNames: occupationNameMap(CATALOG) }));
  assert.equal(en['fla-ada-lead'].description, 'Ada Lead — Alpha — Lead');
  assert.equal(en['fla-gil-global'].description, 'Gil Global — Global — Engineering');
  // Without the catalog the FLA's own role label shows.
  assert.equal(byName(flaMenuEntries(candidates(), { sourceApplication: 'claude_code', language: 'en-US' }))['fla-ada-lead']
    .description, 'Ada Lead — Alpha — Alpha 负责人');
  assert.equal(menuLanguage('', 'zh-Hans-CN'), 'zh-CN');
  assert.equal(menuLanguage('', 'de-DE'), 'en-US');
  assert.equal(menuLanguage('en-US', 'zh-CN'), 'en-US');
});

test('Claude Code\'s inserted /mcp__fuli__fla-… line becomes #FLA with the menu name; anything else is unchanged', () => {
  assert.equal(claudeFlaMenuPrompt('/mcp__fuli__fla-jamie-ash-beta 看一下构建'), '#FLA fla-jamie-ash-beta 看一下构建');
  assert.equal(claudeFlaMenuPrompt('/mcp__fuli__fla-小林'), '#FLA fla-小林');
  assert.equal(claudeFlaMenuPrompt('/mcp__plugin_fuli_fuli__fla-jefa  排一下\n第二行'), '#FLA fla-jefa 排一下\n第二行');
  assert.equal(claudeFlaMenuPrompt('/fuli:fla-ada-lead go'), '#FLA fla-ada-lead go');
  for (const prompt of ['/mcp__other__fla-x hi', '/mcp__fuli__get_status', '/fla', 'fix /mcp__fuli__fla-x', '/review']) {
    assert.equal(claudeFlaMenuPrompt(prompt), prompt);
  }
});

function application({ settings = { enabled: true, language: 'zh-CN' }, roster = ROSTER } = {}) {
  const app = { config: { personal: { spaceId: SPACE } }, roster,
    flaMenuSettings: () => app.settings, settings,
    personal: { listProjectAgents: async () => structuredClone(app.roster), listPersonalProjects: async () => PROJECTS,
      occupationCatalog: async () => CATALOG } };
  return app;
}

async function connect(app, options = {}) {
  const server = new McpServer({ name: 'fuli', version: 'test' });
  const stop = registerFlaMenuPrompts(server, app, { sourceApplication: 'claude_code', ...options });
  const client = new Client({ name: 'synthetic-client', version: '1' });
  const changes = [];
  client.setNotificationHandler(PromptListChangedNotificationSchema, () => changes.push(Date.now()));
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  return { client, changes, close: async () => { stop(); await client.close(); await server.close(); } };
}

const waitFor = async (check, ms = 2000) => {
  for (const started = Date.now(); Date.now() - started < ms;) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('timed out');
};

test('MCP prompts list the menu and expand a pick to #FLA; the client hears of a change and of turning it off', async () => {
  const app = application();
  const { client, changes, close } = await connect(app, { settingsEveryMs: 5, rosterEvery: 2 });
  try {
    assert.equal(client.getServerCapabilities().prompts.listChanged, true);
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.find(item => item.name === 'fla-ada-lead'),
      { name: 'fla-ada-lead', title: 'Ada Lead', description: 'Ada Lead — Alpha — 负责人' });
    assert.equal(prompts.some(item => 'arguments' in item && item.arguments?.length), false, 'the request is typed after the pick');
    const picked = await client.getPrompt({ name: 'fla-jamie-ash-beta' });
    assert.deepEqual(picked.messages, [{ role: 'user', content: { type: 'text', text: '#FLA fla-jamie-ash-beta' } }]);
    await assert.rejects(client.getPrompt({ name: 'fla-nobody' }), /No FLA in the \/fla menu/);

    // A recruit reaches the client on the roster check.
    app.roster = [...ROSTER, fla('new', 'Nia New', 'engineering', 'project-b')];
    await waitFor(() => changes.length === 1);
    assert.ok((await client.listPrompts()).prompts.some(item => item.name === 'fla-nia-new'));

    // The language changes the role text at the next settings check.
    app.settings = { enabled: true, language: 'en-US' };
    await waitFor(() => changes.length === 2);
    assert.equal((await client.listPrompts()).prompts.find(item => item.name === 'fla-ada-lead').description, 'Ada Lead — Alpha — Lead');

    // Off: the menu is empty, and nothing was ever written anywhere.
    app.settings = { enabled: false, language: 'en-US' };
    await waitFor(() => changes.length === 3);
    assert.deepEqual((await client.listPrompts()).prompts, []);
  } finally { await close(); }
});

test('an unreadable roster lists nothing and announces the real list once it can read it', async () => {
  const app = application();
  const listProjectAgents = app.personal.listProjectAgents;
  app.personal.listProjectAgents = async () => { throw new Error('Synthetic Provider outage'); };
  const errors = [];
  const { client, changes, close } = await connect(app, { settingsEveryMs: 5, rosterEvery: 1, onError: error => errors.push(error) });
  try {
    assert.deepEqual((await client.listPrompts()).prompts, []);
    assert.equal(errors.length, 1);
    app.personal.listProjectAgents = listProjectAgents;
    await waitFor(() => changes.length === 1);
    assert.ok((await client.listPrompts()).prompts.length > 0);
  } finally { await close(); }
});

test('names and descriptions stay within agent-installer\'s limits in UTF-16 code units, never splitting a character', () => {
  // A name of 60 non-BMP letters (2 code units each) and a role text with controls and emoji.
  const wide = '𠀀'.repeat(60);
  const roster = [fla('wide', wide, 'engineering', 'project-a', { label: 'Q\u0001A\u0007 🧪\n👩‍💻' }),
    fla('wide-2', wide, 'engineering', 'project-b')];
  const entries = flaMenuEntries(candidates(roster), { sourceApplication: 'claude_code', language: 'zh-CN' });
  // agent-installer 0.4's own rules: a name of at most 64 code units without separators,
  // whitespace, controls or a leading dot; a description of one line without controls.
  const NAME = /^[^\\/:*?"<>|\s.\x00-\x1f\x7f][^\\/:*?"<>|\s\x00-\x1f\x7f]*$/u;
  for (const entry of entries) {
    assert.ok(entry.name.length <= 60 && NAME.test(entry.name), entry.name);
    assert.ok(entry.name.isWellFormed(), 'no character is cut in half');
    assert.doesNotMatch(entry.description, /[\x00-\x1f\x7f]/u);
  }
  assert.equal(new Set(entries.map(entry => entry.name)).size, 2);
  assert.match(entries.find(entry => entry.description.includes('Alpha')).description, /QA 🧪 👩‍💻$/u);
});

test('a roster read in another order announces nothing; only what the client shows counts', async () => {
  const app = application();
  const { client, changes, close } = await connect(app, { settingsEveryMs: 5, rosterEvery: 1 });
  try {
    await client.listPrompts();
    // Recency decides the menu's order: Jamie Ash in Gamma becomes the most recent.
    app.roster = ROSTER.map(agent => agent.agent_id === 'jamie-c' ? { ...agent, updated_at: '2026-11-07T00:00:00Z' } : agent);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(changes.length, 0);
    app.roster = [...ROSTER, fla('new', 'Nia New', 'engineering', 'project-b')];
    await waitFor(() => changes.length === 1);
  } finally { await close(); }
});
