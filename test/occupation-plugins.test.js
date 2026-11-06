import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';
import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { occupationPluginDigest, parseOccupationPluginManifest } from '../src/occupation-plugins/manifest.js';
import { createOccupationPlugins } from '../src/occupation-plugins/port.js';
import { recordRecruitmentKitAnswer, recruitmentKitHint } from '../src/occupation-plugins/recruitment.js';

const BUNDLED = JSON.parse(readFileSync(new URL('../registry/occupation-plugins.json', import.meta.url), 'utf8'));
const SPACE = 'synthetic-space';
const SYNTHETIC_MIT = 'MIT License\n\nCopyright (c) 2026 Synthetic Roles\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this synthetic software.';

// A synthetic manifest: one plugin quoting an MIT role file, one Skill and one MCP server by reference.
function manifest({ manifestVersion = 1, change } = {}) {
  const value = {
    format: 'fuli-occupation-plugins', formatVersion: 1, manifestVersion, updatedAt: '2026-11-06',
    sources: [
      { id: 'synthetic-roles', repository: 'https://github.com/synthetic/roles', commit: 'a'.repeat(40), license: 'MIT',
        copyright: 'Copyright (c) 2026 Synthetic Roles', licenseText: SYNTHETIC_MIT },
      { id: 'synthetic-skills', repository: 'https://github.com/synthetic/skills', commit: 'b'.repeat(40), license: 'Apache-2.0',
        copyright: null, licenseText: null },
      { id: 'synthetic-mcp', repository: 'https://github.com/synthetic/mcp', commit: 'c'.repeat(40), license: 'MIT',
        copyright: null, licenseText: null }
    ],
    plugins: [{
      id: 'testing', version: '1.0.0', occupations: ['testing', 'qa_automation'],
      role: { source: 'synthetic-roles', path: 'roles/qa-expert.md', name: 'qa-expert' },
      checklist: { source: 'synthetic-roles', path: 'roles/qa-expert.md', items: ['Synthetic coverage target met'] },
      acceptance: { source: 'synthetic-roles', path: 'roles/qa-expert.md', items: ['Synthetic zero critical defects'] },
      skills: [{ id: 'synthetic-webapp-testing', name: 'webapp-testing', source: 'synthetic-skills',
        path: 'skills/webapp-testing', summary: 'Synthetic browser testing skill.' }],
      mcpServers: [{ id: 'io.github.synthetic/browser', name: 'Synthetic browser', source: 'synthetic-mcp', path: null,
        summary: 'Synthetic browser automation server.' }]
    }]
  };
  change?.(value);
  for (const plugin of value.plugins) plugin.digest = occupationPluginDigest(plugin, value.sources);
  return value;
}

function withPlugins(run, { bundled = manifest(), remote = null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-occupation-plugins-'));
  const fetchImpl = async () => {
    if (!remote) throw new Error('offline');
    return new Response(JSON.stringify(remote), { status: 200 });
  };
  const plugins = createOccupationPlugins({ statePath: join(directory, 'occupation-plugins.json'),
    choicesPath: join(directory, 'occupation-kit-choices.sqlite'), readBundled: () => bundled, fetchImpl,
    now: () => new Date('2026-11-06T08:00:00Z') });
  return Promise.resolve(run(plugins)).finally(() => { plugins.close(); rmSync(directory, { recursive: true, force: true }); });
}

test('the bundled manifest is valid: every quote carries its upstream license and every occupation exists', () => {
  const parsed = parseOccupationPluginManifest(BUNDLED);
  const catalog = readFileSync(new URL('../graph-provider/fuli_graph/occupation_catalog.py', import.meta.url), 'utf8');
  const builtins = new Set([...catalog.matchAll(/^\s+\('([a-z_]+)', '/gm)].map(match => match[1]));
  for (const plugin of parsed.plugins) {
    for (const key of plugin.occupations) assert.ok(builtins.has(key), `${plugin.id} serves unknown occupation ${key}`);
    for (const piece of [plugin.checklist, plugin.acceptance]) {
      const source = parsed.sources.find(item => item.id === piece.source);
      assert.match(source.licenseText, new RegExp(source.license === 'MIT' ? 'Permission is hereby granted' : '.'));
    }
  }
  for (const key of ['engineering', 'frontend', 'testing', 'project_manager', 'research', 'writing']) {
    assert.ok(parsed.plugins.some(plugin => plugin.occupations.includes(key)), `no starter kit for ${key}`);
  }
});

test('a manifest with an unlicensed or non-commercial source, a bad digest or a doubly served occupation is refused whole', () => {
  const cases = [
    manifest({ change: value => { value.sources[0].license = 'CC-BY-NC-4.0'; } }),
    manifest({ change: value => { value.sources[0].licenseText = null; } }),
    manifest({ change: value => { value.plugins[0].skills[0].source = 'unknown-source'; } }),
    manifest({ change: value => { value.plugins.push({ ...structuredClone(value.plugins[0]), id: 'testing-two' }); } }),
    manifest({ change: value => { value.sources[1].repository = 'http://github.com/synthetic/skills'; } }),
    manifest({ change: value => { value.plugins[0].run = 'calc.exe'; } }),
    { ...manifest(), plugins: manifest().plugins.map(plugin => ({ ...plugin, digest: `sha256:${'0'.repeat(64)}` })) }
  ];
  for (const value of cases) assert.throws(() => parseOccupationPluginManifest(value), { code: 'occupation_plugins_invalid' });
  // A changed source commit changes the plugin's digest: the pin covers where the text came from.
  const moved = manifest({ change: value => { value.sources[0].commit = 'd'.repeat(40); } });
  assert.notEqual(moved.plugins[0].digest, manifest().plugins[0].digest);
});

test('a kit says nothing was enabled until the person answers, and keeps every earlier answer', async () => {
  await withPlugins(async plugins => {
    const before = plugins.kit({ personalSpaceId: SPACE, agentId: 'fla-1', occupation: 'qa_automation' });
    assert.equal(before.plugin.id, 'testing');
    assert.equal(before.skills[0].enabled, null);
    assert.equal(before.checklist.from.license, 'MIT');
    assert.equal(before.checklist.from.url, `https://github.com/synthetic/roles/blob/${'a'.repeat(40)}/roles/qa-expert.md`);
    assert.equal(before.skills[0].url, `https://github.com/synthetic/skills/tree/${'b'.repeat(40)}/skills/webapp-testing`);
    assert.throws(() => plugins.choose({ personalSpaceId: SPACE, agentId: 'fla-1', occupation: 'testing', skills: ['not-recommended'] }),
      { code: 'invalid_input' });
    assert.throws(() => plugins.choose({ personalSpaceId: SPACE, agentId: 'fla-1', occupation: 'legal' }), { code: 'invalid_input' });
    plugins.choose({ personalSpaceId: SPACE, agentId: 'fla-1', occupation: 'testing', skills: ['synthetic-webapp-testing'], answeredBy: 'recruitment' });
    const after = plugins.choose({ personalSpaceId: SPACE, agentId: 'fla-1', occupation: 'testing', mcpServers: ['io.github.synthetic/browser'] });
    assert.deepEqual([after.skills[0].enabled, after.mcpServers[0].enabled], [false, true]);
    assert.deepEqual(after.choice, { pluginVersion: '1.0.0', answeredBy: 'person', at: '2026-11-06T08:00:00.000Z', outdated: false });
    assert.equal(after.earlierChoices, 1);
    assert.deepEqual(plugins.kit({ personalSpaceId: SPACE, occupation: 'legal' }), { occupation: 'legal', plugin: null });
  });
});

test('a newer public manifest is shown, applied by its digest, and marks older answers outdated', async () => {
  const remote = manifest({ manifestVersion: 2, change: value => {
    value.plugins[0].version = '1.1.0';
    value.plugins[0].checklist.items.push('Synthetic regression suite green');
  } });
  await withPlugins(async plugins => {
    plugins.choose({ personalSpaceId: SPACE, agentId: 'fla-1', occupation: 'testing', skills: ['synthetic-webapp-testing'] });
    assert.equal(plugins.list().autoUpdate, true);
    const checked = await plugins.check();
    assert.equal(checked.status, 'update_available');
    assert.deepEqual(checked.diff.changed, [{ id: 'testing', from: '1.0.0', to: '1.1.0' }]);
    assert.throws(() => plugins.apply('another-digest'), { code: 'occupation_plugins_changed', status: 409 });
    const listed = plugins.apply(checked.digest);
    assert.equal(listed.source, 'updated');
    const kit = plugins.kit({ personalSpaceId: SPACE, agentId: 'fla-1', occupation: 'testing' });
    assert.equal(kit.plugin.version, '1.1.0');
    assert.equal(kit.choice.outdated, true);
    assert.equal(kit.skills[0].enabled, true);
    const list = plugins.list();
    assert.deepEqual(list.sources.map(item => item.license), ['MIT', 'Apache-2.0', 'MIT']);
    assert.equal(list.plugins[0].checklistCount, 2);
  }, { remote });
});

function application(plugins, { nodes = [] } = {}) {
  return {
    config: { personal: { spaceId: SPACE } }, externalKnowledge: null, occupationPlugins: plugins,
    listProjectAgents: async () => [
      { agentId: 'fla-qa', occupation: { role: 'qa_automation' } },
      { agentId: 'fla-qa-2', occupation: { role: 'qa_automation' } },
      { agentId: 'fla-dev', occupation: { role: 'engineering' } }
    ],
    personal: { graph: async () => ({ nodes, edges: [] }) }
  };
}

const experience = (id, proposer, overrides = {}) => ({ id, name: `Synthetic lesson ${id}`, type: 'ReusableExperience',
  attributes: { solution: 'Synthetic: run the focused suite first' }, confirmation_status: 'confirmed',
  confirmation_basis: { proposed_by: { kind: 'agent', label: proposer } }, qualified_use_count: 2, distinct_task_count: 2, ...overrides });

test('an FLA reads its kit by its own occupation, with kept project lessons and checks on top', async () => {
  await withPlugins(async plugins => {
    const app = application(plugins, { nodes: [
      experience('kept-qa', 'fla-qa-2', { attributes: { solution: 'Synthetic', check: 'Synthetic: the smoke test passes' } }),
      experience('pending-qa', 'fla-qa', { confirmation_status: 'pending' }),
      experience('kept-dev', 'fla-dev')
    ] });
    const kit = await callAgentTool(app, 'read_occupation_kit', { personalSpaceId: SPACE, agentId: 'fla-qa', personalProjectId: 'p1' });
    assert.equal(kit.occupation, 'qa_automation');
    assert.deepEqual(kit.learned.lessons.map(item => item.itemId), ['kept-qa']);
    assert.deepEqual(kit.learned.checks, [{ itemId: 'kept-qa', check: 'Synthetic: the smoke test passes' }]);
    const plain = await callAgentTool(app, 'read_occupation_kit', { personalSpaceId: SPACE, occupation: 'testing' });
    assert.equal(plain.learned, undefined);
    await assert.rejects(callAgentTool(app, 'read_occupation_kit', { personalSpaceId: SPACE }), { code: 'invalid_input' });
  });
});

test('a pending recruitment names its kit, and the person\'s answer rides on the approval', async () => {
  await withPlugins(async plugins => {
    const app = application(plugins);
    const hint = recruitmentKitHint(app, SPACE, ['qa_automation', 'legal', null]);
    assert.deepEqual(hint.kits, [{ occupation: 'qa_automation', plugin: 'testing@1.0.0',
      skills: ['synthetic-webapp-testing'], mcpServers: ['io.github.synthetic/browser'] }]);
    assert.equal(recruitmentKitHint(app, SPACE, ['legal']), null);
    const record = { recruitedAgentId: 'fla-new', occupation: { role: 'testing' } };
    const input = { personalSpaceId: SPACE, decision: 'approve', occupationKit: { skills: ['synthetic-webapp-testing'] } };
    assert.deepEqual(recordRecruitmentKitAnswer(app, input, record),
      { status: 'recorded', plugin: 'testing@1.0.0', skills: ['synthetic-webapp-testing'], mcpServers: [] });
    assert.equal(plugins.kit({ personalSpaceId: SPACE, agentId: 'fla-new', occupation: 'testing' }).choice.answeredBy, 'recruitment');
    assert.equal(recordRecruitmentKitAnswer(app, { ...input, decision: 'cancel' }, record), null);
    assert.equal(recordRecruitmentKitAnswer(app, { ...input, occupationKit: { skills: ['nope'] } }, record).status, 'not_recorded');
  });
});

test('the kit is one full-profile read that chat discovers on demand, and nothing of it enters the task entry', () => {
  const tool = listAgentTools().find(({ name }) => name === 'read_occupation_kit');
  assert.ok(tool);
  const workflow = agentInterfaceCatalog().readWorkflows.find(({ toolNames }) => toolNames.includes('read_occupation_kit'));
  assert.deepEqual(workflow.readRoutes, ['GET /api/occupation-plugins', 'GET /api/project-agents/:agentId/occupation-kit']);
});
