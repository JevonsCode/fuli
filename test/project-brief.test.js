import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectAgentRoleContext } from '../src/graphiti/project-agent-task-entry.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { entryRules } from '../src/conversations/entry-rules.js';
import { registerRepositoryProject } from '../src/graphiti/repository-project-registration.js';
import { providerProjectProfile } from '../src/graphiti/project-profile-mapping.js';
import { requiresSymlinks } from '../test-support/platform-capabilities.js';

const agent = { profile: { name: 'A', responsibility: 'Keep responsibility', initialPreferences: ['Keep instruction'], character: {} } };
test('entry carries a bounded single-line brief and roster primary occupations, retaining current role and preferences', () => {
  const profile = { name: 'Sample', purpose: 'Useful\nproject', scope: 'S'.repeat(4096), technical_summary: 'PRIVATE_TECH'.repeat(100), boundaries: ['B'.repeat(1000)] };
  const role = projectAgentRoleContext(agent, profile);
  const value = compactTaskContext({ effective_preferences: [{ instruction: 'Authoritative instruction' }], project_agent_context: {
    ...role, team: { roster: [{ name: 'Ada', occupation: 'engineering', responsibility: 'Long duty' }], assigned_collaborators: [{ name: 'Bo', occupation: null }], assigned_peers: [], guidance: 'Keep reporting authority' }
  } });
  assert.equal(typeof value.project_agent_context.project_brief.summary, 'string');
  assert.ok([...value.project_agent_context.project_brief.summary].length <= 240);
  assert.doesNotMatch(value.project_agent_context.project_brief.summary, /\n/);
  assert.equal(value.project_agent_context.project_brief.technical_summary, undefined);
  assert.deepEqual(value.project_agent_context.team, { roster: [{ name: 'Ada', occupation: 'engineering' }, { name: 'Bo', occupation: null }] });
  assert.equal(value.project_agent_context.team_guidance, 'Keep reporting authority');
  assert.deepEqual(value.project_agent_context.role.initial_preferences, ['Keep instruction']);
  assert.equal(value.effective_preferences[0].instruction, 'Authoritative instruction');
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < Buffer.byteLength(JSON.stringify(profile)) / 2);
});

test('repository creation extracts a README draft before first task without model calls', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fuli-brief-'));
  try {
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, 'README.md'), '# Demo\n\n[![Build](badge)](build)\n\nA tool for tracking sample requests.\n\n## Usage\nDo something else.');
    const writes = [];
    await registerRepositoryProject({ config: { personal: { spaceId: 'space' } }, upsertPersonalProject: async input => writes.push(input) },
      { repositoryProjectId: 'demo' }, { projectPath: root, taskPrompt: 'Build a tracker' });
    assert.equal(writes[0].profile.purpose, 'A tool for tracking sample requests.');
    assert.deepEqual(writes[0].profile.brief_draft, { source: 'readme', label: 'AI draft', editable: true });
    assert.deepEqual(providerProjectProfile(writes[0].profile).brief_draft, writes[0].profile.brief_draft);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repository without README remains unresolved and never persists the transient raw task prompt', async () => {
  const writes = [];
  const app = { config: { personal: { spaceId: 'space' } }, upsertPersonalProject: async input => writes.push(input) };
  const resolution = { status: 'unmatched', repositoryProjectId: 'demo' };
  assert.equal(await registerRepositoryProject(app, resolution), resolution);
  assert.equal(writes.length, 0);
  await registerRepositoryProject(app, resolution, { taskPrompt: 'PRIVATE_RAW_TASK_SENTINEL' });
  assert.equal(writes.length, 0);
  assert.doesNotMatch(JSON.stringify(resolution), /PRIVATE_RAW_TASK_SENTINEL/);
});

test('large team roster deduplicates stable identities and defers overflow', () => {
  const roster = Array.from({ length: 30 }, (_, i) => ({ agent_id: `a-${i}`, name: `Agent ${i}`, occupation: 'engineering' }));
  const view = compactTaskContext({ project_agent_context: { team: { roster, assigned_collaborators: roster.slice(0, 2), assigned_peers: [] } } }).project_agent_context;
  assert.equal(view.team.roster.length, 4);
  assert.equal(view.team.roster_total, 30);
  assert.equal(view.team.roster_truncated, true);
  assert.equal(view.details_guidance.rules, 'fuli://rules/task-entry#details_guidance');
  assert.match(entryRules().sections.details_guidance, /get_project_team/);
  assert.deepEqual(Object.keys(view.team.roster[0]), ['name', 'occupation']);
});

test('repository brief ignores README symlinks escaping the repository', requiresSymlinks, async t => {
  const { symlink } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'fuli-brief-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, '.git'), { recursive: true });
  await writeFile(path.join(root, 'outside.md'), 'PRIVATE_OUTSIDE_SENTINEL');
  await symlink(path.join(root, 'outside.md'), path.join(repo, 'README.md'));
  const writes = [];
  const result = await registerRepositoryProject({ config: { personal: { spaceId: 'space' } }, upsertPersonalProject: async input => writes.push(input) },
    { status: 'unmatched', repositoryProjectId: 'demo' }, { projectPath: repo });
  assert.equal(writes.length, 0);
  assert.equal(result.status, 'unmatched');
});

test('short and full profiles with small, large and long-name teams never enlarge the previous entry', async t => {
  const { loadProjectTeamContext } = await import('../src/graphiti/project-agent-team-context.js');
  for (const profile of [
    { name: 'P', purpose: 'Simple tracker' },
    { name: 'P', purpose: 'Simple tracker', brief_draft: { source: 'readme', label: 'AI draft', editable: true } },
    { name: 'Sample', purpose: 'Track requests for the sample team.', scope: 'Local requests only.',
      technical_summary: 'JavaScript service backed by a local graph.', boundaries: ['No external publication.'] }
  ]) for (const count of [1, 4, 30]) for (const longNames of [false, true]) {
    const people = Array.from({ length: count }, (_, i) => ({ agent_id: `a-${i}`, occupation: { role: 'engineering' },
      profile: { name: longNames ? '名'.repeat(150) + i : `Agent ${i}` },
      assignments: [{ personal_project_id: 'p', status: 'active' }] }));
    const team = await loadProjectTeamContext({ personal: {
      getProjectAgentCoordinationPolicy: async () => ({ team_lead_agent_id: 'a-0', team_member_agent_ids: people.slice(1).map(person => person.agent_id) }),
      listProjectAgents: async () => people
    } }, 'space', 'p');
    const value = compactTaskContext({ project_agent_context: {
      ...projectAgentRoleContext({ profile: { name: 'A', initialPreferences: [], character: {} } }, profile), team
    } });
    // Exact pre-R05 projection: no team, original team guidance and full profile.
    const before = { project_agent_context: { ...value.project_agent_context, team: undefined,
      team_guidance: team.guidance,
      project_brief: { name: profile.name, purpose: profile.purpose, scope: profile.scope,
        technical_summary: profile.technical_summary, boundaries: profile.boundaries ?? [] } } };
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const baseline = Buffer.byteLength(JSON.stringify(before));
    t.diagnostic(`${profile.name}, draft=${Boolean(profile.brief_draft)}, ${count} members, long=${longNames}: ${baseline} -> ${bytes} bytes`);
    assert.ok(bytes <= baseline, `${count} members: ${bytes} > ${baseline}`);
    assert.equal(value.project_agent_context.project_brief.name, profile.name);
    if (profile.brief_draft) assert.match(value.project_agent_context.project_brief.summary, /AI draft \(editable\)/);
  }
});
