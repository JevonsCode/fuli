"""The installed Claude Code hook against the real HTTP Provider and a disposable Neo4j.

rec#15: a host-notification or isMeta turn re-reads the current task in place and
is held as unresolved. Its Stop neither settles that task nor records the turn
under it, until an explicit, successful continuation in a turn or a fresh task
entry. Every hook call is its own Node process, as Claude Code runs it; the state
between calls is only what FULI persists (the Provider, the capture ledger) and
the synthetic native transcript this test writes as the host. Synthetic
identities and payloads only; no model, client or real transcript.
"""
import asyncio
import base64
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import shutil
import socket

import pytest
from neo4j import AsyncGraphDatabase

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent
from test_system_hr_identity_neo4j import _create_space

PREFERENCE = 'synthetic-hook-refresh-style'
NOTIFICATION = '<task-notification>\n<task-id>bsynth272</task-id>\n<status>completed</status>\n</task-notification>'
CI_EVENT = '<ci-monitor-event>"Auto-fix" saw PR #1 fail.</ci-monitor-event>'
UNCONFIRMED = '来源和任务归属都未确认'
NO_VALID = 'FULI: no valid task context is established for this turn'

# One command per process. The runtime lease is a pass-through: the test owns this Provider and graph.
DRIVER = r'''
import { pathToFileURL } from 'node:url';
const [root, runtime, command, payload] = process.argv.slice(1);
const request = JSON.parse(payload);
const load = path => import(pathToFileURL(root + path).href);
const { openFederatedGraphApplication } = await load('/src/graphiti/federated-application.js');
const withApp = async operation => {
  const app = openFederatedGraphApplication({ runtimeConfigPath: runtime });
  try { return await operation(app); } finally { await app.close?.(); }
};
let result;
if (command === 'hook') {
  const { runClaudeLifecycleHook } = await load('/src/agents/claude-code/lifecycle-hook.js');
  const { event, ...input } = request;
  result = await runClaudeLifecycleHook(['--event', event], { readInput: async () => input, captureTimeoutMs: 30000,
    resolveRuntimeOptions: () => ({ runtimeConfigPath: runtime }),
    createLeases: () => ({ withGraphLease: async (_owner, run) => run(), close: async () => {} }) });
} else if (command === 'current') {
  const task = await withApp(app => app.taskContextRegistry.current(request.session, 'claude_code'));
  result = task && { token: task.token, checkpoint: task.checkpoint?.phase ?? null, projectAgentId: task.projectAgentId,
    personalProjectId: task.personalProjectId, preferenceScope: task.preferenceScope };
} else if (command === 'checkpoint') {
  // The model's own MCP call, made explicitly for this turn.
  const { callAgentTool } = await load('/src/agent-tools.js');
  result = await withApp(app => callAgentTool(app, 'checkpoint_task_knowledge', { taskContextToken: request.token,
    sourceApplication: 'claude_code', disposition: 'retain_nothing', reason: 'Synthetic explicit continuation.',
    workLog: { status: 'completed', summary: 'Synthetic task finished after its background notification.' } }));
} else if (command === 'held') {
  const { transcriptCaptureLedger } = await load('/src/conversations/transcript-capture-gap.js');
  result = await transcriptCaptureLedger(runtime, { session_id: request.session }, 'claude_code').unresolvedTurn();
}
process.stdout.write(JSON.stringify(result ?? null));
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


async def _recorded(settings, session):
    """Every conversation event the Provider stored for a session: (task token, content)."""
    async with AsyncGraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password)) as driver:
        rows, _, _ = await driver.execute_query(
            'MATCH (e:FuliConversationEvent {session_id: $session}) RETURN e.task_context_token AS token, e.payload AS payload',
            session=session)
    return [(row['token'], json.loads(gzip.decompress(base64.b64decode(row['payload'])))['content']) for row in rows]


class Host:
    """A synthetic Claude Code host: it writes the native transcript and runs each hook in a fresh process."""

    def __init__(self, node, root, runtime, directory, cwd):
        self.node, self.root, self.runtime, self.directory, self.cwd = node, root, runtime, directory, cwd
        self.calls = 0

    def transcript(self, session):
        return self.directory / f'{session}.jsonl'

    def write(self, session, record):
        with self.transcript(session).open('a', encoding='utf-8') as file:
            file.write(json.dumps({'sessionId': session, **record}, ensure_ascii=False) + '\n')

    def user(self, session, text):
        self.write(session, {'type': 'user', 'message': {'role': 'user', 'content': text}})

    def reply(self, session, text):
        self.write(session, {'type': 'assistant', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': text}]}})

    def tool(self, session, call_id, name, arguments, *, error=False):
        self.write(session, {'type': 'assistant', 'message': {'role': 'assistant', 'content': [
            {'type': 'tool_use', 'id': call_id, 'name': name, 'input': arguments}]}})
        self.write(session, {'type': 'user', 'message': {'role': 'user', 'content': [
            {'type': 'tool_result', 'tool_use_id': call_id, 'content': 'synthetic result', 'is_error': error}]}})

    async def run(self, command, payload):
        self.calls += 1
        process = await asyncio.create_subprocess_exec(self.node, '--input-type=module', '-e', DRIVER,
            str(self.root), str(self.runtime), command, json.dumps(payload),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=180)
        assert process.returncode == 0, stderr.decode()
        return json.loads(stdout.decode() or 'null')

    async def hook(self, session, event, **fields):
        return await self.run('hook', {'event': event, 'session_id': session, 'cwd': str(self.cwd),
            'transcript_path': str(self.transcript(session)), **fields})

    async def prompt(self, session, text, **fields):
        self.user(session, text)
        output = await self.hook(session, 'UserPromptSubmit', prompt=text, **fields)
        return (output.get('hookSpecificOutput') or {}).get('additionalContext', '')

    async def current(self, session):
        return await self.run('current', {'session': session})

    async def held(self, session):
        return await self.run('held', {'session': session})


def token_of(context):
    marker = '"taskContextToken":"'
    return context.split(marker, 1)[1].split('"', 1)[0] if marker in context else None


@pytest.mark.asyncio
async def test_claude_unresolved_turns_never_settle_or_record_under_the_current_task(tmp_path):
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
        host = Host(node, root, runtime, tmp_path, cwd)
        server = uvicorn.Server(uvicorn.Config(client._transport.app, lifespan='off', log_level='error'))
        serving = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            for _ in range(100):
                if server.started:
                    break
                await asyncio.sleep(0.05)
            assert server.started

            async def unfinished_task(session, text):
                # The task's own Stop did not run (as when a host Stop hook times out), so it stays open.
                await host.hook(session, 'UserPromptSubmit', prompt='/fuli start')
                context = await host.prompt(session, text)
                token = token_of(context)
                assert token, context
                host.reply(session, f'Started {text}')
                return token

            async def held_turn(session, prompt, reply):
                context = await host.prompt(session, prompt)
                host.reply(session, reply)
                return context

            async def stops_settle_nothing(session, token, label):
                before = await host.current(session)
                for _ in range(2):
                    await host.hook(session, 'Stop')
                    assert await host.current(session) == before, f'{label}: the held task is unchanged'
                assert before['token'] == token and before['checkpoint'] is None, label
                assert await host.held(session), f'{label}: the turn stays held'

            session = 'synthetic-hook-refresh-a'
            task_a = await unfinished_task(session, 'Synthetic task A: build the sample in the background.')
            await _set_preference(settings, space, 2)

            # A notification-shaped turn and the same envelope pasted by a person: identical to the hook.
            for label, prompt, reply in [('notification-shaped turn', NOTIFICATION, 'SYNTHETIC_NOTIFICATION_REPLY'),
                                         ('pasted envelope', NOTIFICATION, 'SYNTHETIC_PASTE_REPLY'),
                                         ('CI envelope', CI_EVENT, 'SYNTHETIC_CI_REPLY')]:
                context = await held_turn(session, prompt, reply)
                assert UNCONFIRMED in context and "is not this turn's confirmed task" in context, context
                assert 'Synthetic preference revision 2' in context and 'Synthetic preference revision 1' not in context
                assert 'not a new user task' not in context
                await stops_settle_nothing(session, task_a, label)
            system = await host.prompt(session, 'Synthetic system delivery.', isMeta=True)
            assert 'host system delivery, but its task ownership is not confirmed' in system, system
            host.reply(session, 'SYNTHETIC_SYSTEM_REPLY')
            await stops_settle_nothing(session, task_a, 'isMeta turn')

            # Calls that name A's token but do not state this turn is A's.
            for label, call_id, name, failed in [('read-only call', 'toolu_read', 'mcp__fuli__read_task_preferences', False),
                                                  ('failed checkpoint', 'toolu_failed', 'mcp__fuli__checkpoint_task_knowledge', True)]:
                await held_turn(session, NOTIFICATION, f'SYNTHETIC_{call_id.upper()}_REPLY')
                host.tool(session, call_id, name, {'taskContextToken': task_a}, error=failed)
                await stops_settle_nothing(session, task_a, label)
            # A checkpoint call from an earlier turn whose result lands in a newer turn.
            await held_turn(session, NOTIFICATION, 'SYNTHETIC_OLD_CALL_REPLY')
            host.write(session, {'type': 'assistant', 'message': {'role': 'assistant', 'content': [{'type': 'tool_use',
                'id': 'toolu_old', 'name': 'mcp__fuli__checkpoint_task_knowledge', 'input': {'taskContextToken': task_a}}]}})
            older = await host.held(session)
            await held_turn(session, NOTIFICATION, 'SYNTHETIC_DELAYED_RECEIPT_REPLY')
            newer = await host.held(session)
            assert newer['turn'] != older['turn']
            host.write(session, {'type': 'user', 'message': {'role': 'user', 'content': [
                {'type': 'tool_result', 'tool_use_id': 'toolu_old', 'content': 'synthetic result'}]}})
            await stops_settle_nothing(session, task_a, 'delayed receipt')

            texts = [content for _, content in await _recorded(settings, session)]
            for reply in ['SYNTHETIC_NOTIFICATION_REPLY', 'SYNTHETIC_PASTE_REPLY', 'SYNTHETIC_CI_REPLY', 'SYNTHETIC_SYSTEM_REPLY',
                          'SYNTHETIC_TOOLU_READ_REPLY', 'SYNTHETIC_TOOLU_FAILED_REPLY', 'SYNTHETIC_DELAYED_RECEIPT_REPLY']:
                assert not any(reply in text for text in texts), reply
            assert any('task ownership was not confirmed' in text for text in texts), texts

            # An explicit, successful continuation in the turn: recording and checkpoint resume for A.
            await held_turn(session, NOTIFICATION, 'SYNTHETIC_CONTINUED_REPLY')
            await host.run('checkpoint', {'token': task_a})
            host.tool(session, 'toolu_ok', 'mcp__fuli__checkpoint_task_knowledge', {'taskContextToken': task_a})
            await host.hook(session, 'Stop')
            assert await host.held(session) is None
            assert (await host.current(session))['checkpoint'] == 'complete'
            recorded = await _recorded(settings, session)
            assert any(token == task_a and 'SYNTHETIC_CONTINUED_REPLY' in text for token, text in recorded), recorded

            # An explicit new task B enters normally, gets its own token and is settled by its own Stop.
            entered = await host.prompt(session, 'Synthetic task B: write the release note.')
            task_b = token_of(entered)
            assert task_b and task_b != task_a and UNCONFIRMED not in entered, entered
            host.reply(session, 'SYNTHETIC_TASK_B_REPLY')
            await host.hook(session, 'Stop')
            current = await host.current(session)
            assert current['token'] == task_b and current['checkpoint'] == 'complete', current
            assert any(token == task_b and 'SYNTHETIC_TASK_B_REPLY' in text for token, text in await _recorded(settings, session))
            closed = await host.prompt(session, NOTIFICATION)
            assert NO_VALID in closed and 'the current task of this session is closed' in closed and 'fuli-task-' not in closed

            # Restart, resume, clear and compaction leave the turn held: repeated Stops never settle A2.
            restart = 'synthetic-hook-refresh-restart'
            task_r = await unfinished_task(restart, 'Synthetic task A2: watch the deploy.')
            await held_turn(restart, NOTIFICATION, 'SYNTHETIC_BEFORE_RESET_REPLY')
            await stops_settle_nothing(restart, task_r, 'before reset')
            for label, event, fields in [('restart', 'SessionStart', {'source': 'startup'}),
                                         ('resume', 'SessionStart', {'source': 'resume'}),
                                         ('clear', 'SessionStart', {'source': 'clear'}),
                                         ('compaction', 'PreCompact', {'trigger': 'auto'})]:
                await host.hook(restart, event, **fields)
                host.reply(restart, f'SYNTHETIC_AFTER_{label.upper()}_REPLY')
                await stops_settle_nothing(restart, task_r, label)
            texts = [content for _, content in await _recorded(settings, restart)]
            assert not any('SYNTHETIC_BEFORE_RESET_REPLY' in text or 'SYNTHETIC_AFTER_' in text for text in texts), texts

            # FULI turned off for the session leaves the turn held as well.
            off = 'synthetic-hook-refresh-off'
            task_o = await unfinished_task(off, 'Synthetic task A3: run the migration check.')
            await held_turn(off, NOTIFICATION, 'SYNTHETIC_BEFORE_OFF_REPLY')
            await host.hook(off, 'UserPromptSubmit', prompt='/fuli stop')
            await stops_settle_nothing(off, task_o, 'FULI off')
            off_turn = await host.prompt(off, NOTIFICATION)
            assert 'FULI' in off_turn and task_o not in off_turn
            host.reply(off, 'SYNTHETIC_WHILE_OFF_REPLY')
            await stops_settle_nothing(off, task_o, 'FULI off, repeated')
            texts = [content for _, content in await _recorded(settings, off)]
            assert not any('SYNTHETIC_BEFORE_OFF_REPLY' in text or 'SYNTHETIC_WHILE_OFF_REPLY' in text for text in texts)

            # No valid task context: none is established, no token shown, nothing created or switched.
            empty = 'synthetic-hook-refresh-empty'
            await host.hook(empty, 'UserPromptSubmit', prompt='/fuli start')
            none = await host.prompt(empty, NOTIFICATION)
            assert NO_VALID in none and 'this session has no current task' in none and 'fuli-task-' not in none
            assert await host.current(empty) is None
            for label, session_id, change in [
                    ('invalid scope', 'synthetic-hook-refresh-scopeless', lambda record: record.pop('preference_scope', None)),
                    ('missing Agent', 'synthetic-hook-refresh-agentless', lambda record: record.update(project_agent_id=None))]:
                token = await unfinished_task(session_id, f'Synthetic task for {label}.')
                await _edit_task(settings, token, change)
                context = await host.prompt(session_id, NOTIFICATION)
                assert NO_VALID in context and 'ownership or scope could not be confirmed' in context, context
                assert 'fuli-task-' not in context, label
                assert (await host.current(session_id))['token'] == token, label
            print(json.dumps({'hook_processes': host.calls, 'source': 'real HTTP Provider and isolated Neo4j', 'synthetic': True}))
        finally:
            server.should_exit = True
            await serving
