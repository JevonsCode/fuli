import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { writeRecord } from '../src/runner/follower-local-runtime.js';
import { ownIssuer } from '../src/runner/task-issuer.js';
import { pairedFollower } from '../test-support/paired-follower.js';
import { enabled, replicaFixture } from '../test-support/replica-neo4j.js';

// docs/runner-roles-design.md §11 3b/3c end to end, on a disposable Neo4j: a follower paired with a host over a
// real runner listener keeps a new project on itself (an id other than its folder's name) through its own MCP
// tool; that project's entry is answered by the follower's real own half on its own Provider (global a copy),
// with the host's habit read from the copy; its checkpoint writes its project fact here and sends its global
// preference to the host; its first task's lead is asked of the host, at once while it answers and by itself
// once it answers again. The host's graph is played by its application double (host-global-writes.js applies
// each op through it); its global is exported by its real Provider before the follower takes the Neo4j over.
// Synthetic names only.
const HABIT = 'Synthetic host habit: answers in short paragraphs';
const confirmed = { existence_reason: 'Synthetic.', quadrant_reason: 'Synthetic.', proposed_by: { kind: 'user' },
  confirmed_by: { kind: 'user' }, confirmed_at: '2026-11-01T00:00:00Z' };
const basis = { existenceReason: 'Synthetic', quadrantReason: 'Synthetic', proposedBy: { kind: 'agent' } };

async function until(check, what, { withinMs = 30_000 } = {}) {
  for (const deadline = Date.now() + withinMs; Date.now() < deadline; await delay(200)) if (await check()) return;
  assert.fail(`timed out waiting for ${what}`);
}

const text = (answer) => answer.content?.map((part) => part.text ?? '').join('\n') ?? '';
const value = (answer) => answer.structuredContent ?? JSON.parse(text(answer));

test('real Neo4j: a new project kept on a follower is answered there with the host\'s habits, and sends to the host what is global',
  { skip: !enabled, timeout: 480_000 }, async (t) => {
    const captured = [];
    const hired = [];
    const hostApp = { config: { personal: { spaceId: null } },
      captureSessionKnowledge: async (input) => {
        captured.push(input);
        return { route: 'personal', status: 'committed', episode_id: 'synthetic-host-episode', entity_ids: [], relationship_ids: [] };
      },
      personal: { hireForFollowerRecruitment: async (hire) => { hired.push(hire); return { agent_id: hire.agentId }; } } };
    const follower = await pairedFollower(t, { ownHalf: true, hostApp, hostDirectory: [],
      // The host has no project of these ids, names or folders.
      hostAnswer: (name, input) => [name, input?.toolName].includes('list_personal_projects') ? { projects: [] } : { status: 'recorded' } });
    const fixture = await replicaFixture(t, { dataDir: follower.dataDir, owner: follower.hostFingerprint,
      seedHost: ({ request, token, spaceId }) => request('/v1/knowledge/commits', { space_id: spaceId, episode: {
        idempotency_key: 'synthetic-host-habit', session_id: 'synthetic-host-session', name: 'Synthetic host habit',
        source_kind: 'task_remember', source_application: 'codex', source_turn_id: 'synthetic-turn',
        source_description: 'Synthetic capture.', reference_time: '2026-11-20T00:00:00Z',
        entities: [{ key: 'host-habit', name: HABIT, type: 'PersonalPreference', summary: HABIT, profile_aspect: 'taste',
          confirmation_status: 'confirmed', confirmation_basis: confirmed }] } }, { token }) });
    hostApp.config.personal.spaceId = fixture.spaceId;
    assert.equal((await fixture.sync(true)).outcome, 'synced');
    // This computer's runtime as its preparation leaves it, and its console running the graph (follower-runtime-broker.js).
    writeRecord(follower.dataDir, { state: 'ready', createdHere: true, projects: [], running: true,
      space: { state: 'same', id: fixture.spaceId } });
    writeFileSync(path.join(follower.dataDir, 'graph-runtime-state.json'), JSON.stringify({ follower: true, pid: process.pid }));

    // Kept here at the person's ask, under an id other than its folder's name.
    const folder = path.join(follower.base, 'checkout-x');
    mkdirSync(folder);
    const kept = await follower.client.callTool({ name: 'keep_project_on_this_computer',
      arguments: { projectPath: folder, projectId: 'synthetic-widgets', name: 'Synthetic widgets' } });
    assert.equal(kept.isError, undefined, text(kept));
    assert.equal(value(kept).scope, 'project:synthetic-widgets');
    const projects = await fixture.client().listPersonalProjects(fixture.spaceId);
    assert.ok(projects.some((project) => project.project_id === 'synthetic-widgets'), 'made in this computer\'s graph');

    // The entry by its folder: answered here, the host's habit from the copy, the token naming this computer.
    const entry = await follower.client.callTool({ name: 'get_collaboration_preferences',
      arguments: { sessionId: 'synthetic-e2e-session', projectPath: folder, taskPrompt: 'Build the synthetic widgets' } });
    assert.equal(entry.isError, undefined, text(entry));
    const entered = value(entry);
    assert.equal(entered.context?.personal_project_id, 'synthetic-widgets', text(entry).slice(0, 2000));
    assert.match(text(entry), new RegExp(HABIT.slice(0, 30)), 'the host\'s habit, read from the copy here');
    assert.match(entered.runner?.message ?? '', /this computer[\s\S]*Host A/);
    const token = entered.taskContextToken;
    assert.ok(token?.startsWith(`fuli-from-${ownIssuer(follower.dataDir)}.`), token);
    assert.equal(follower.calls.some((call) => [call.name, call.input?.toolName].includes('get_collaboration_preferences')),
      false, 'nothing of the entry went to the host');

    // Its first task has no lead yet: the host is asked to make one, for this project.
    await until(() => hired.length > 0, 'the host to be asked for the project\'s lead');
    assert.equal(hired[0].origin.project, 'Synthetic widgets');
    assert.match(hired[0].recruitmentId, /\S/);

    // The checkpoint: the project fact here, the global preference to the host.
    const checkpoint = await follower.client.callTool({ name: 'checkpoint_task_knowledge', arguments: {
      taskContextToken: token, disposition: 'capture_candidates', reason: 'Synthetic checkpoint of a local project.',
      capture: { idempotencyKey: 'synthetic-local-capture', name: 'Synthetic local capture', sourceKind: 'synthetic',
        sourceDescription: 'Synthetic fixture', referenceTime: '2026-11-25T00:00:00Z',
        sourceExcerpt: 'I want short replies everywhere, in every project.',
        entities: [
          { key: 'fact', name: 'Synthetic widgets build with one command', type: 'ProjectFact',
            originQuadrant: 'known_known', confirmationStatus: 'pending', confirmationBasis: basis },
          { key: 'habit', name: 'Synthetic follower habit: short replies', type: 'PersonalPreference', profileAspect: 'taste',
            originQuadrant: 'known_known', confirmationStatus: 'pending', confirmationBasis: basis }],
        relationships: [] },
      captureRouting: [{ scope: 'current_project', entityKeys: ['fact'], relationshipKeys: [] },
        { scope: 'personal_global', entityKeys: ['habit'], relationshipKeys: [] }] } });
    assert.equal(checkpoint.isError, undefined, text(checkpoint));
    await until(() => captured.length > 0, 'the global preference to reach the host');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].personalProjectId, null);
    assert.deepEqual(captured[0].entities.map((item) => item.name), ['Synthetic follower habit: short replies']);
    const here = await fixture.cypher(`MATCH (n:Entity) WHERE n.name IN $names RETURN n.name AS name ORDER BY name`,
      { names: ['Synthetic widgets build with one command', 'Synthetic follower habit: short replies'] });
    assert.deepEqual(here.map((row) => row.name), ['Synthetic widgets build with one command'],
      'the project\'s fact written here; the global preference not');

    // A second new project made while the host answers; its first task entered while the host is away:
    // the lead waits, and goes to the host by itself once it answers again.
    const second = path.join(follower.base, 'gadgets');
    mkdirSync(second);
    const made = await follower.client.callTool({ name: 'keep_project_on_this_computer',
      arguments: { projectPath: second } });
    assert.equal(made.isError, undefined, text(made));
    follower.hostAway();
    const away = await follower.client.callTool({ name: 'get_collaboration_preferences',
      arguments: { sessionId: 'synthetic-e2e-session-2', projectPath: second, taskPrompt: 'Start the synthetic gadgets' } });
    assert.equal(away.isError, undefined, text(away));
    assert.equal(value(away).context?.personal_project_id, 'gadgets', 'answered here with the host away');
    assert.equal(hired.length, 1, 'not yet');
    follower.hostBack();
    await follower.client.callTool({ name: 'list_personal_projects', arguments: {} });
    await until(() => hired.length > 1, 'the waiting lead to reach the host once it answers', { withinMs: 60_000 });
    assert.equal(hired[1].origin.project, 'gadgets');
    await fixture.stop();
  });
