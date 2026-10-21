"""The installed Claude Code hook against the real HTTP Provider and a disposable Neo4j.

rec#15: a host-notification or isMeta turn re-reads the current task in place.
It must not begin or switch a task, because the Provider checkpoints only
``session.current_token``. Synthetic identities and payloads only; no model,
client or real transcript.
"""
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import socket

import pytest
from neo4j import AsyncGraphDatabase

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent
from test_system_hr_identity_neo4j import _create_space

PREFERENCE = 'synthetic-hook-refresh-style'

# One hook process per call, as Claude Code runs it. The runtime lease is a
# pass-through: the test owns this Provider and graph.
DRIVER = r'''
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [root, runtime, statePath, phase] = process.argv.slice(1);
const load = path => import(pathToFileURL(root + path).href);
const { runClaudeLifecycleHook } = await load('/src/agents/claude-code/lifecycle-hook.js');
const { callAgentTool } = await load('/src/agent-tools.js');
const { openFederatedGraphApplication } = await load('/src/graphiti/federated-application.js');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const hook = input => runClaudeLifecycleHook(['--event', 'UserPromptSubmit'], { readInput: async () => input,
  resolveRuntimeOptions: () => ({ runtimeConfigPath: runtime }),
  createLeases: () => ({ withGraphLease: async (_owner, run) => run(), close: async () => {} }) });
const turn = async (sessionId, prompt, extra = {}) => (await hook({ session_id: sessionId, cwd: state.cwd, prompt, ...extra }))
  .hookSpecificOutput?.additionalContext ?? '';
const tokenOf = context => /"taskContextToken":"(fuli-task-[^"]+)"/.exec(context)?.[1] ?? null;
const withApp = async operation => {
  const app = openFederatedGraphApplication({ runtimeConfigPath: runtime });
  try { return await operation(app); } finally { await app.close?.(); }
};
const current = sessionId => withApp(app => app.taskContextRegistry.current(sessionId, 'claude_code'));
const checkpoint = token => withApp(app => callAgentTool(app, 'checkpoint_task_knowledge', { taskContextToken: token,
  sourceApplication: 'claude_code', disposition: 'retain_nothing', reason: 'Synthetic hook refresh acceptance.',
  workLog: { status: 'completed', summary: 'Synthetic task finished after its background notification.' } }));
const notification = '<task-notification>\n<task-id>bsynth272</task-id>\n<status>completed</status>\n</task-notification>';
const unconfirmed = /来源和任务归属都未确认.*its source and task ownership are not confirmed; no task was created or switched/;
const noValid = /FULI：本轮没有建立有效的任务上下文.*FULI: no valid task context is established for this turn/;
const ownership = task => task && { token: task.token, checkpoint: task.checkpoint, projectAgentId: task.projectAgentId,
  personalProjectId: task.personalProjectId, preferenceScope: task.preferenceScope };
const result = {};
if (phase === 'start') {
  for (const session of state.sessions) await turn(session, '/fuli start');
  for (const [key, session] of [['taskA', state.session], ['scopelessTask', state.scopelessSession],
    ['agentlessTask', state.agentlessSession]]) {
    const context = await turn(session, `Synthetic user task for ${key}: build the sample in the background.`);
    result[key] = tokenOf(context);
    assert.ok(result[key], context);
    assert.match(context, /Synthetic preference revision 1/);
  }
} else if (phase === 'notify') {
  const before = ownership(await current(state.session));
  assert.equal(before.token, state.taskA);
  // The same envelope twice: once as the host would deliver it, once pasted by a person.
  // The hook cannot tell them apart and treats both alike.
  for (const [label, prompt, extra] of [['notification-shaped turn', notification, {}], ['pasted envelope', notification, {}],
    ['CI monitor envelope', '<ci-monitor-event>"Auto-fix" saw PR #1 fail.</ci-monitor-event>', {}]]) {
    const context = await turn(state.session, prompt, extra);
    assert.match(context, unconfirmed, label);
    assert.match(context, /is not this turn's confirmed task/, label);
    assert.match(context, /start a task explicitly with get_collaboration_preferences/, label);
    assert.doesNotMatch(context, /not a new user task|Pass taskContextToken to every FULI call/, label);
    // The preference changed while A's background work ran; the reference is fresh and complete.
    assert.match(context, /Synthetic preference revision 2/, label);
    assert.doesNotMatch(context, /Synthetic preference revision 1/, label);
    assert.deepEqual(ownership(await current(state.session)), before, `${label}: A is unchanged and still current`);
  }
  const system = await turn(state.session, 'Synthetic system delivery.', { isMeta: true });
  assert.match(system, /host system delivery, but its task ownership is not confirmed/, system);
  assert.deepEqual(ownership(await current(state.session)), before);
  // A keeps its checkpoint: the Provider accepts only the current token.
  await checkpoint(state.taskA);
  assert.equal((await current(state.session)).checkpoint?.phase, 'complete');
  // An explicit move into new work enters normally and gets its own token.
  const entered = await turn(state.session, 'Synthetic task B: write the release note.');
  result.taskB = tokenOf(entered);
  assert.ok(result.taskB && result.taskB !== state.taskA, entered);
  assert.doesNotMatch(entered, /not confirmed/);
  assert.equal((await current(state.session)).token, result.taskB);
  // No valid task context: none is established, and no old token is presented as this turn's task.
  const cases = [['no current task', state.emptySession, /this session has no current task/, null],
    ['closed task', state.session, /the current task of this session is closed/, result.taskB],
    ['invalid scope', state.scopelessSession, /ownership or scope could not be confirmed/, state.scopelessTask],
    ['missing Agent', state.agentlessSession, /ownership or scope could not be confirmed/, state.agentlessTask]];
  await checkpoint(result.taskB);
  for (const [label, session, reason, token] of cases) {
    const context = await turn(session, notification);
    assert.match(context, noValid, `${label}: ${context}`);
    assert.match(context, reason, label);
    assert.doesNotMatch(context, /fuli-task-/, label);
    assert.equal((await current(session))?.token ?? null, token, `${label}: no task was created or switched`);
  }
}
writeFileSync(statePath, JSON.stringify({ ...state, ...result }));
console.log(JSON.stringify({ phase, ...result }));
'''


async def _set_preference(settings, space, revision):
    basis = json.dumps({'existence_reason': 'Synthetic hook refresh fixture.',
                        'quadrant_reason': 'Synthetic user-confirmed fixture rule.',
                        'proposed_by': {'kind': 'user', 'label': 'Synthetic fixture'},
                        'confirmed_by': {'kind': 'user', 'label': 'Synthetic fixture'},
                        'confirmed_at': '2026-10-22T00:00:00Z'})
    async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
        await driver.execute_query('''
            MATCH (space:FuliSpace {id:$space})
            MERGE (item:Entity {uuid:$id})
            SET item.group_id = space.group_id, item.name = $key, item.created_at = $stamp,
                item.summary = $instruction, item.fuli_type = 'PersonalPreference',
                item.fuli_profile_aspect = 'judgment_preference', item.fuli_preference_scope = 'global',
                item.fuli_confirmation_status = 'confirmed', item.fuli_confirmation_basis_json = $basis,
                item.fuli_attributes_json = $attributes
            ''', space=space, id=f'{space}-{PREFERENCE}', key=PREFERENCE, basis=basis,
            instruction=f'Synthetic preference revision {revision}: lead with the result.',
            attributes=json.dumps({'preferenceKey': PREFERENCE}), stamp=datetime(2026, 10, 22, tzinfo=timezone.utc))


async def _edit_task(settings, token, change):
    async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
        rows, _, _ = await driver.execute_query(
            'MATCH (task:FuliTaskContext {token: $token}) RETURN task.record_json AS record_json', token=token)
        record = json.loads(rows[0]['record_json'])
        change(record)
        await driver.execute_query('MATCH (task:FuliTaskContext {token: $token}) SET task.record_json = $record_json',
            token=token, record_json=json.dumps(record))


@pytest.mark.asyncio
async def test_claude_notification_turns_refresh_the_current_task_without_switching_it(tmp_path):
    import uvicorn
    settings = fixture_settings()
    root = Path(__file__).resolve().parents[2]
    node = shutil.which('node')
    assert node
    async with provider_client(settings) as (client, access_token):
        space = await _create_space(client, 'Synthetic Claude hook refresh')
        await seed_agent(client, space, allowed_clients=['claude_code'])
        await _set_preference(settings, space, 1)
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
        runtime = tmp_path / 'data' / 'runtime.json'
        runtime.parent.mkdir()
        runtime.write_text(json.dumps({'version': 1, 'workspaces': [], 'personal': {
            'providerUrl': f'http://127.0.0.1:{port}', 'accessToken': access_token,
            'principalId': 'synthetic-hook-refresh', 'spaceId': space}}))
        runtime.chmod(0o600)
        cwd = tmp_path / 'sample-project'
        cwd.mkdir()
        state_path = tmp_path / 'state.json'
        sessions = {'session': 'synthetic-hook-refresh-a', 'emptySession': 'synthetic-hook-refresh-empty',
                    'scopelessSession': 'synthetic-hook-refresh-scopeless',
                    'agentlessSession': 'synthetic-hook-refresh-agentless'}
        state_path.write_text(json.dumps({'cwd': str(cwd), **sessions, 'sessions': list(sessions.values())}))
        server = uvicorn.Server(uvicorn.Config(client._transport.app, lifespan='off', log_level='error'))
        serving = asyncio.create_task(server.serve(sockets=[listener]))

        async def run(phase):
            process = await asyncio.create_subprocess_exec(node, '--input-type=module', '-e', DRIVER,
                str(root), str(runtime), str(state_path), phase,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=180)
            assert process.returncode == 0, stderr.decode()
            print(stdout.decode().strip())

        try:
            for _ in range(100):
                if server.started:
                    break
                await asyncio.sleep(0.05)
            assert server.started
            await run('start')
            await _set_preference(settings, space, 2)
            state = json.loads(state_path.read_text())
            # Stored tasks this version cannot own: an unknown (legacy) scope and no Agent identity.
            await _edit_task(settings, state['scopelessTask'], lambda record: record.pop('preference_scope', None))
            await _edit_task(settings, state['agentlessTask'], lambda record: record.update(project_agent_id=None))
            await run('notify')
        finally:
            server.should_exit = True
            await serving
