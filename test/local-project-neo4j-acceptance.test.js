import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { writeRecord } from '../src/runner/follower-local-runtime.js';
import { createScopeExport, SCOPE_EXPORT_KEEP_MS } from '../src/runner/host-scope-export.js';
import { ownIssuer } from '../src/runner/task-issuer.js';
import { taskCloseConsole } from '../src/task-closing/console-port.js';
import { pairedFollower } from '../test-support/paired-follower.js';
import { pairedProjectGraphs } from '../test-support/paired-project-graphs.js';
import { enabled } from '../test-support/replica-neo4j.js';

// A paired host and follower with separate disposable Neo4j databases and real Providers.
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
  { skip: !enabled || !process.env.FULI_TEST_FOLLOWER_NEO4J_URI, timeout: 480_000 }, async (t) => {
    const graphs = await pairedProjectGraphs(t, ({ request, token, spaceId }) => request('/v1/knowledge/commits', { space_id: spaceId, episode: {
        idempotency_key: 'synthetic-host-habit', session_id: 'synthetic-host-session', name: 'Synthetic host habit',
        source_kind: 'task_remember', source_application: 'codex', source_turn_id: 'synthetic-turn',
        source_description: 'Synthetic capture.', reference_time: '2026-11-20T00:00:00Z',
        entities: [{ key: 'host-habit', name: HABIT, type: 'PersonalPreference', summary: HABIT, profile_aspect: 'taste',
          confirmation_status: 'confirmed', confirmation_basis: confirmed }] } }, { token }));
    const { hostApp } = graphs;
    const hired = [];
    const hire = hostApp.personal.hireForFollowerRecruitment.bind(hostApp.personal);
    hostApp.personal.hireForFollowerRecruitment = async input => {
      const result = await hire(input);
      hired.push(input);
      return result;
    };
    let time = Date.now();
    const follower = await pairedFollower(t, { ownHalf: true, hostApp,
      hostDirectory: () => hostApp.listPersonalProjects({ personalSpaceId: graphs.spaceId }),
      scopeExport: createScopeExport({ app: hostApp, now: () => time }) });
    const fixture = await graphs.connectFollower(follower.dataDir);
    assert.equal((await fixture.sync()).outcome, 'synced');
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
    assert.equal(entry.isError, undefined, value(entry)?.error?.code);
    const entered = value(entry);
    assert.equal(entered.context?.personal_project_id, 'synthetic-widgets', entered.context?.project_resolution?.basis);
    assert.ok(entered.effective_preferences?.some(item => item.instruction === HABIT), 'the host habit is read from the copy');
    assert.match(entered.runner?.message ?? '', /this computer[\s\S]*Host A/);
    const token = entered.taskContextToken;
    assert.ok(token?.startsWith(`fuli-from-${ownIssuer(follower.dataDir)}.`), 'the follower issued the task');
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
          { key: 'second', name: 'Synthetic widgets use the blue theme', type: 'ProjectFact',
            originQuadrant: 'known_known', confirmationStatus: 'pending', confirmationBasis: basis },
          { key: 'habit', name: 'Synthetic follower habit: short replies', type: 'PersonalPreference', profileAspect: 'taste',
            originQuadrant: 'known_known', confirmationStatus: 'pending', confirmationBasis: basis }],
        relationships: [] },
      captureRouting: [{ scope: 'current_project', entityKeys: ['fact', 'second'], relationshipKeys: [] },
        { scope: 'personal_global', entityKeys: ['habit'], relationshipKeys: [] }] } });
    assert.equal(checkpoint.isError, undefined, text(checkpoint));
    const names = ['Synthetic widgets build with one command', 'Synthetic widgets use the blue theme',
      'Synthetic follower habit: short replies'];
    const entities = 'MATCH (n:Entity) WHERE n.group_id = $group AND n.name IN $names RETURN n.name AS name ORDER BY name';
    const [{ group }] = await fixture.cypher('MATCH (s:FuliSpace {id: $id}) RETURN s.group_id AS group', { id: graphs.spaceId });
    const onHost = () => graphs.hostRows(entities, { names, group });
    await until(async () => (await onHost()).length > 0, 'the global preference to reach the real host graph');
    assert.deepEqual((await onHost()).map(row => row.name), [names[2]]);
    assert.deepEqual((await fixture.cypher(entities, { names, group })).map(row => row.name), names.slice(0, 2));
    time += SCOPE_EXPORT_KEEP_MS + 1;
    assert.equal((await fixture.sync()).outcome, 'synced');
    assert.deepEqual((await fixture.cypher(entities, { names, group })).map(row => row.name), [...names].sort());
    const [agent] = await fixture.cypher('MATCH (a:FuliProjectAgent {agent_id: $agent}) RETURN a.fuli_replica_owner AS owner',
      { agent: hired[0].agentId });
    assert.equal(agent?.owner, follower.hostFingerprint);

    const scope = { personal_space_id: graphs.spaceId, personal_project_id: 'synthetic-widgets' };
    const provider = fixture.client();
    await provider.updateProjectAgentCoordinationPolicy({ ...scope, ask_before_recruitment: false, auto_reuse_previous_agent: true });
    const temporary = key => provider.submitProjectAgentTask({ ...scope, idempotency_key: key, title: key,
      objective: 'Verify the synthetic widgets.', work_kind: 'verification', source_application: 'codex',
      staffing_intent: 'temporary', duration: 'one_off', routing_reason: 'Synthetic acceptance.' });
    follower.hostAway();
    const waiting = await temporary('sample-later');
    assert.equal(waiting.recruitment.status, 'blocked');
    assert.equal(waiting.task.status, 'awaiting_recruitment');
    const toCancel = await temporary('sample-cancel');
    assert.equal(toCancel.task.status, 'awaiting_recruitment');
    const cancelled = await taskCloseConsole(follower.dataDir).closeAsPerson(toCancel.task.task_id, {
      personalSpaceId: graphs.spaceId, personalProjectId: 'synthetic-widgets', status: 'cancelled', summary: 'Synthetic task withdrawn.' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(hired.length, 1);
    follower.hostBack();
    time += SCOPE_EXPORT_KEEP_MS + 1;
    // The follower console's normal sync round drains its outbox without a new client turn.
    assert.equal((await fixture.round()).outcome, 'synced');
    const tasks = await provider.listProjectAgentTasks({ personalSpaceId: graphs.spaceId, personalProjectId: 'synthetic-widgets' });
    const staffed = tasks.find(task => task.task_id === waiting.task.task_id);
    assert.ok(staffed);
    assert.notEqual(staffed.status, 'awaiting_recruitment');
    assert.equal(staffed.lead_agent_id, waiting.recruitment.proposed_agent_id);
    assert.equal(hired.filter(hire => hire.taskId === staffed.task_id).length, 1);
    assert.equal(hired.some(hire => hire.taskId === toCancel.task.task_id), false);
    const withdrawn = tasks.find(task => task.task_id === toCancel.task.task_id);
    assert.equal(withdrawn?.status, 'cancelled');
    assert.notEqual(withdrawn.lead_agent_id, toCancel.recruitment.proposed_agent_id);
    await fixture.stop();
  });
