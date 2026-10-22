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
from contextlib import asynccontextmanager
import hashlib
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import shutil
import socket
import sqlite3
from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from test_project_agent_memory_neo4j import fixture_settings, provider_client, seed_agent
from test_system_hr_identity_neo4j import _create_space

PREFERENCE = 'synthetic-hook-refresh-style'
NOTIFICATION = '<task-notification>\n<task-id>bsynth272</task-id>\n<status>completed</status>\n</task-notification>'
CI_EVENT = '<ci-monitor-event>"Auto-fix" saw PR #1 fail.</ci-monitor-event>'
UNCONFIRMED = '来源和任务归属都未确认'
NO_VALID = 'FULI: no valid task context is established for this turn'

# One command per process, for the Agent `source` names. The runtime lease is a
# pass-through: the test owns this Provider and graph. The hook's own stdout
# write is dropped; the driver prints the hook's result.
DRIVER = r'''
import { pathToFileURL } from 'node:url';
const [root, runtime, source, command, payload] = process.argv.slice(1);
const request = JSON.parse(payload);
const load = path => import(pathToFileURL(root + path).href);
const { openFederatedGraphApplication } = await load('/src/graphiti/federated-application.js');
const withApp = async operation => {
  const app = openFederatedGraphApplication({ runtimeConfigPath: runtime });
  try { return await operation(app); } finally { await app.close?.(); }
};
const HOOKS = { claude_code: ['/src/agents/claude-code/lifecycle-hook.js', 'runClaudeLifecycleHook'],
  codex: ['/src/agents/codex/lifecycle-hook.js', 'runCodexLifecycleHook'] };
let result;
if (command === 'hook') {
  const runHook = (await load(HOOKS[source][0]))[HOOKS[source][1]];
  const { event, ...input } = request;
  result = await runHook(['--event', event], { readInput: async () => input, write: () => {}, captureTimeoutMs: 30000,
    resolveRuntimeOptions: () => ({ runtimeConfigPath: runtime }),
    createLeases: () => ({ withGraphLease: async (_owner, run) => run(), close: async () => {} }) });
} else if (command === 'current') {
  const task = await withApp(app => app.taskContextRegistry.current(request.session, source));
  result = task && { token: task.token, checkpoint: task.checkpoint?.phase ?? null, projectAgentId: task.projectAgentId,
    personalProjectId: task.personalProjectId, preferenceScope: task.preferenceScope };
} else if (command === 'checkpoint') {
  // The model's own MCP call, made explicitly for this turn.
  const { callAgentTool } = await load('/src/agent-tools.js');
  result = await withApp(app => callAgentTool(app, 'checkpoint_task_knowledge', { taskContextToken: request.token,
    sourceApplication: source, disposition: 'retain_nothing', reason: 'Synthetic explicit continuation.',
    workLog: { status: 'completed', summary: 'Synthetic task finished after its background notification.' } }));
} else if (command === 'held') {
  const { transcriptCaptureLedger } = await load('/src/conversations/transcript-capture-gap.js');
  result = transcriptCaptureLedger(runtime, { session_id: request.session }, source).heldTurns();
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
    source = 'claude_code'

    def __init__(self, node, root, runtime, directory, cwd):
        self.node, self.root, self.runtime, self.directory, self.cwd = node, root, runtime, directory, cwd
        self.calls = 0
        # Session ids unique to this run: the disposable graph may keep earlier runs' events.
        self.suffix = uuid4().hex[:12]

    def sid(self, name):
        return f'{name}-{self.suffix}'

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
            str(self.root), str(self.runtime), self.source, command, json.dumps(payload),
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

    def ledger_path(self, session, directory='transcript-capture'):
        key = hashlib.sha256(f'{self.runtime}\0{self.source}\0{session}'.encode()).hexdigest()
        return self.runtime.parent / directory / f'{key}.json'

    async def unfinished_task(self, session, text):
        # The task's own Stop did not run (as when a host Stop hook times out), so it stays open.
        await self.hook(session, 'UserPromptSubmit', prompt='/fuli start')
        context = await self.prompt(session, text)
        token = token_of(context)
        assert token, context
        self.reply(session, f'Started {text}')
        return token

    async def held_turn(self, session, prompt, reply):
        context = await self.prompt(session, prompt)
        self.reply(session, reply)
        return context

    async def stops_settle_nothing(self, session, label, *, token=None, checkpoint=None):
        before = await self.current(session)
        for _ in range(2):
            await self.hook(session, 'Stop')
            assert await self.current(session) == before, f'{label}: the task of the session is unchanged'
        if token:
            assert before['token'] == token and before['checkpoint'] == checkpoint, label
        held = await self.held(session)
        assert held['unprovable'] or held['turns'], f'{label}: the turn stays held'


def token_of(context):
    marker = '"taskContextToken":"'
    return context.split(marker, 1)[1].split('"', 1)[0] if marker in context else None


@asynccontextmanager
async def claude_host(tmp_path, host_class=Host):
    """A disposable Provider over HTTP with one synthetic project, Agent and preference, for host_class's Agent."""
    import uvicorn
    settings = fixture_settings()
    root = Path(__file__).resolve().parents[2]
    node = shutil.which('node')
    assert node
    async with provider_client(settings) as (client, access_token):
        space = await _create_space(client, f'Synthetic {host_class.source} hook refresh')
        await seed_agent(client, space, allowed_clients=[host_class.source])
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
        host = host_class(node, root, runtime, tmp_path, cwd)
        server = uvicorn.Server(uvicorn.Config(client._transport.app, lifespan='off', log_level='error'))
        serving = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            for _ in range(100):
                if server.started:
                    break
                await asyncio.sleep(0.05)
            assert server.started
            yield host, settings, space
            print(json.dumps({'hook_processes': host.calls, 'source': 'real HTTP Provider and isolated Neo4j', 'synthetic': True}))
        finally:
            server.should_exit = True
            await serving


@pytest.mark.asyncio
async def test_claude_unresolved_turns_never_settle_or_record_under_the_current_task(tmp_path):
    async with claude_host(tmp_path) as (host, settings, space):
        session = host.sid('synthetic-hook-refresh-a')
        task_a = await host.unfinished_task(session, 'Synthetic task A: build the sample in the background.')
        await _set_preference(settings, space, 2)

        # A notification-shaped turn and the same envelope pasted by a person: identical to the hook.
        for label, prompt, reply in [('notification-shaped turn', NOTIFICATION, 'SYNTHETIC_NOTIFICATION_REPLY'),
                                     ('pasted envelope', NOTIFICATION, 'SYNTHETIC_PASTE_REPLY'),
                                     ('CI envelope', CI_EVENT, 'SYNTHETIC_CI_REPLY')]:
            context = await host.held_turn(session, prompt, reply)
            assert UNCONFIRMED in context and "is not this turn's confirmed task" in context, context
            assert 'Synthetic preference revision 2' in context and 'Synthetic preference revision 1' not in context
            assert 'not a new user task' not in context
            await host.stops_settle_nothing(session, label, token=task_a)
        system = await host.prompt(session, 'Synthetic system delivery.', isMeta=True)
        assert 'host system delivery, but its task ownership is not confirmed' in system, system
        host.reply(session, 'SYNTHETIC_SYSTEM_REPLY')
        await host.stops_settle_nothing(session, 'isMeta turn', token=task_a)

        # Calls that name A's token but do not state this turn is A's.
        for label, call_id, name, failed in [('read-only call', 'toolu_read', 'mcp__fuli__read_task_preferences', False),
                                              ('failed checkpoint', 'toolu_failed', 'mcp__fuli__checkpoint_task_knowledge', True)]:
            await host.held_turn(session, NOTIFICATION, f'SYNTHETIC_{call_id.upper()}_REPLY')
            host.tool(session, call_id, name, {'taskContextToken': task_a}, error=failed)
            await host.stops_settle_nothing(session, label, token=task_a)
        # A checkpoint call from an earlier turn whose result lands in a newer turn.
        await host.held_turn(session, NOTIFICATION, 'SYNTHETIC_OLD_CALL_REPLY')
        host.write(session, {'type': 'assistant', 'message': {'role': 'assistant', 'content': [{'type': 'tool_use',
            'id': 'toolu_old', 'name': 'mcp__fuli__checkpoint_task_knowledge', 'input': {'taskContextToken': task_a}}]}})
        older = (await host.held(session))['turns'][-1]
        await host.held_turn(session, NOTIFICATION, 'SYNTHETIC_DELAYED_RECEIPT_REPLY')
        newer = (await host.held(session))['turns'][-1]
        assert newer['turn'] != older['turn']
        host.write(session, {'type': 'user', 'message': {'role': 'user', 'content': [
            {'type': 'tool_result', 'tool_use_id': 'toolu_old', 'content': 'synthetic result'}]}})
        await host.stops_settle_nothing(session, 'delayed receipt', token=task_a)

        texts = [content for _, content in await _recorded(settings, session)]
        for reply in ['SYNTHETIC_NOTIFICATION_REPLY', 'SYNTHETIC_PASTE_REPLY', 'SYNTHETIC_CI_REPLY', 'SYNTHETIC_SYSTEM_REPLY',
                      'SYNTHETIC_TOOLU_READ_REPLY', 'SYNTHETIC_TOOLU_FAILED_REPLY', 'SYNTHETIC_DELAYED_RECEIPT_REPLY']:
            assert not any(reply in text for text in texts), reply
        assert any('task ownership was not confirmed' in text for text in texts), texts

        # An explicit, successful continuation in the turn: recording and checkpoint resume for A.
        await host.held_turn(session, NOTIFICATION, 'SYNTHETIC_CONTINUED_REPLY')
        await host.run('checkpoint', {'token': task_a})
        host.tool(session, 'toolu_ok', 'mcp__fuli__checkpoint_task_knowledge', {'taskContextToken': task_a})
        await host.hook(session, 'Stop')
        assert (await host.held(session))['turns'] == []
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
        restart = host.sid('synthetic-hook-refresh-restart')
        task_r = await host.unfinished_task(restart, 'Synthetic task A2: watch the deploy.')
        await host.held_turn(restart, NOTIFICATION, 'SYNTHETIC_BEFORE_RESET_REPLY')
        await host.stops_settle_nothing(restart, 'before reset', token=task_r)
        for label, event, fields in [('restart', 'SessionStart', {'source': 'startup'}),
                                     ('resume', 'SessionStart', {'source': 'resume'}),
                                     ('clear', 'SessionStart', {'source': 'clear'}),
                                     ('compaction', 'PreCompact', {'trigger': 'auto'})]:
            await host.hook(restart, event, **fields)
            host.reply(restart, f'SYNTHETIC_AFTER_{label.upper()}_REPLY')
            await host.stops_settle_nothing(restart, label, token=task_r)
        texts = [content for _, content in await _recorded(settings, restart)]
        assert not any('SYNTHETIC_BEFORE_RESET_REPLY' in text or 'SYNTHETIC_AFTER_' in text for text in texts), texts

        # FULI turned off for the session leaves the turn held as well.
        off = host.sid('synthetic-hook-refresh-off')
        task_o = await host.unfinished_task(off, 'Synthetic task A3: run the migration check.')
        await host.held_turn(off, NOTIFICATION, 'SYNTHETIC_BEFORE_OFF_REPLY')
        await host.hook(off, 'UserPromptSubmit', prompt='/fuli stop')
        await host.stops_settle_nothing(off, 'FULI off', token=task_o)
        off_turn = await host.prompt(off, NOTIFICATION)
        assert 'FULI' in off_turn and task_o not in off_turn
        host.reply(off, 'SYNTHETIC_WHILE_OFF_REPLY')
        await host.stops_settle_nothing(off, 'FULI off, repeated', token=task_o)
        texts = [content for _, content in await _recorded(settings, off)]
        assert not any('SYNTHETIC_BEFORE_OFF_REPLY' in text or 'SYNTHETIC_WHILE_OFF_REPLY' in text for text in texts)

        # No valid task context: none is established, no token shown, nothing created or switched.
        empty = host.sid('synthetic-hook-refresh-empty')
        await host.hook(empty, 'UserPromptSubmit', prompt='/fuli start')
        none = await host.prompt(empty, NOTIFICATION)
        assert NO_VALID in none and 'this session has no current task' in none and 'fuli-task-' not in none
        assert await host.current(empty) is None
        for label, session_id, change in [
                ('invalid scope', host.sid('synthetic-hook-refresh-scopeless'), lambda record: record.pop('preference_scope', None)),
                ('missing Agent', host.sid('synthetic-hook-refresh-agentless'), lambda record: record.update(project_agent_id=None))]:
            token = await host.unfinished_task(session_id, f'Synthetic task for {label}.')
            await _edit_task(settings, token, change)
            context = await host.prompt(session_id, NOTIFICATION)
            assert NO_VALID in context and 'ownership or scope could not be confirmed' in context, context
            assert 'fuli-task-' not in context, label
            assert (await host.current(session_id))['token'] == token, label


@pytest.mark.asyncio
async def test_claude_turns_stay_held_without_valid_context_lost_state_or_proof_of_an_older_span(tmp_path):
    async with claude_host(tmp_path) as (host, settings, space):
        def recorded_texts(session):
            return _recorded(settings, session)

        async def nothing_recorded(session, *replies):
            texts = [content for _, content in await recorded_texts(session)]
            for reply in replies:
                assert not any(reply in text for text in texts), (reply, texts)

        # 1. No valid task context still holds the turn: a closed A, no task, another session, a failed read.
        closed = host.sid('synthetic-held-closed')
        task_closed = await host.unfinished_task(closed, 'Synthetic task A: finish the release.')
        await host.run('checkpoint', {'token': task_closed})
        context = await host.held_turn(closed, NOTIFICATION, 'SYNTHETIC_AFTER_CLOSE_REPLY')
        assert NO_VALID in context and 'the current task of this session is closed' in context
        await host.stops_settle_nothing(closed, 'closed A', token=task_closed, checkpoint='complete')
        await nothing_recorded(closed, 'SYNTHETIC_AFTER_CLOSE_REPLY')

        empty = host.sid('synthetic-held-no-task')
        await host.hook(empty, 'UserPromptSubmit', prompt='/fuli start')
        context = await host.held_turn(empty, NOTIFICATION, 'SYNTHETIC_NO_TASK_REPLY')
        assert NO_VALID in context and 'this session has no current task' in context
        await host.hook(empty, 'Stop')
        assert await host.current(empty) is None
        await nothing_recorded(empty, 'SYNTHETIC_NO_TASK_REPLY')

        for label, session, change, reason in [
                ('another session', host.sid('synthetic-held-cross'), lambda record: record.update(session_id='synthetic-other-session'),
                 'the current task belongs to another session'),
                ('failed read', host.sid('synthetic-held-unreadable'), lambda record: record.pop('preference_scope', None),
                 'ownership or scope could not be confirmed')]:
            token = await host.unfinished_task(session, f'Synthetic second task for {label}.')
            await _edit_task(settings, token, change)
            context = await host.held_turn(session, NOTIFICATION, f'SYNTHETIC_{label.upper().replace(" ", "_")}_REPLY')
            assert NO_VALID in context and reason in context, context
            for _ in range(2):
                await host.hook(session, 'Stop')
            current = await host.current(session)
            assert current is None or current['checkpoint'] is None, f'{label}: nothing was settled'
            await nothing_recorded(session, f'SYNTHETIC_{label.upper().replace(" ", "_")}_REPLY')

        # 2. A state that cannot be written or read holds the session; nothing is imported or settled.
        unwritable = host.sid('synthetic-held-unwritable')
        task_w = await host.unfinished_task(unwritable, 'Synthetic task: ledger cannot be written.')
        host.ledger_path(unwritable).unlink(missing_ok=True)
        host.ledger_path(unwritable).mkdir(parents=True)
        await host.held_turn(unwritable, NOTIFICATION, 'SYNTHETIC_UNWRITABLE_REPLY')
        assert host.ledger_path(unwritable, 'transcript-turn-holds').exists(), 'the turn is kept in its own hold'
        await host.stops_settle_nothing(unwritable, 'ledger write failure', token=task_w)
        await nothing_recorded(unwritable, 'SYNTHETIC_UNWRITABLE_REPLY')
        host.ledger_path(unwritable).rmdir()
        # A fresh entry proves the state again; the new task starts and settles normally.
        task_w2 = token_of(await host.prompt(unwritable, 'Synthetic next task after recovery.'))
        host.reply(unwritable, 'SYNTHETIC_RECOVERED_REPLY')
        await host.hook(unwritable, 'Stop')
        current = await host.current(unwritable)
        assert current['token'] == task_w2 and current['checkpoint'] == 'complete', current
        assert any(token == task_w2 and 'SYNTHETIC_RECOVERED_REPLY' in text for token, text in await recorded_texts(unwritable))
        await nothing_recorded(unwritable, 'SYNTHETIC_UNWRITABLE_REPLY')

        corrupt = host.sid('synthetic-held-corrupt')
        task_c = await host.unfinished_task(corrupt, 'Synthetic task: ledger cannot be read.')
        await host.held_turn(corrupt, NOTIFICATION, 'SYNTHETIC_CORRUPT_REPLY')
        host.ledger_path(corrupt).write_text('{not json')
        await host.stops_settle_nothing(corrupt, 'ledger read failure', token=task_c)
        for label, content in [('newer ledger version', json.dumps({'version': 3, 'settings': 'absent'}))]:
            host.ledger_path(corrupt).write_text(content)
            await host.stops_settle_nothing(corrupt, label, token=task_c)
            assert host.ledger_path(corrupt).read_text() == content, f'{label}: a newer record is never rewritten'
        await nothing_recorded(corrupt, 'SYNTHETIC_CORRUPT_REPLY')

        locked = host.sid('synthetic-held-locked')
        task_l = await host.unfinished_task(locked, 'Synthetic second task: ledger lock is held.')
        lock_path = host.ledger_path(locked).parent / '.fuli-format.lock'
        lock = sqlite3.connect(str(lock_path), isolation_level=None, timeout=0)
        lock.execute('BEGIN IMMEDIATE')
        try:
            await host.held_turn(locked, NOTIFICATION, 'SYNTHETIC_LOCKED_REPLY')
        finally:
            lock.execute('ROLLBACK')
            lock.close()
        assert host.ledger_path(locked, 'transcript-turn-holds').exists(), 'a lock conflict falls back to its own hold'
        await host.stops_settle_nothing(locked, 'ledger lock conflict', token=task_l)
        await nothing_recorded(locked, 'SYNTHETIC_LOCKED_REPLY')

        nowhere = host.sid('synthetic-held-nowhere')
        task_n = await host.unfinished_task(nowhere, 'Synthetic task: nothing can be written.')
        for directory in ['transcript-capture', 'transcript-turn-holds']:
            path = host.ledger_path(nowhere, directory)
            path.unlink(missing_ok=True)
            path.mkdir(parents=True)
        host.user(nowhere, NOTIFICATION)
        blocked = await host.hook(nowhere, 'UserPromptSubmit', prompt=NOTIFICATION)
        reason = blocked.get('reason', '')
        assert blocked.get('decision') == 'block' and 'held this message back' in reason, blocked
        # The reason names the cause and the recovery, and nothing is resent for the person.
        assert 'transcript-turn-holds/' in reason and 'resend the message yourself' in reason and 'does not resend' in reason
        assert 'FULI 不会自动重发' in reason
        assert (await host.current(nowhere))['token'] == task_n

        # 3. N1 without a Stop, then N2 explicitly continued: only N2 is the task's, N1 is a skipped span.
        spans = host.sid('synthetic-held-spans')
        task_s = await host.unfinished_task(spans, 'Synthetic second task: two notifications without a Stop.')
        await host.held_turn(spans, NOTIFICATION, 'SYNTHETIC_N1_REPLY')
        await host.held_turn(spans, NOTIFICATION, 'SYNTHETIC_N2_REPLY')
        assert len((await host.held(spans))['turns']) == 2
        await host.run('checkpoint', {'token': task_s})
        host.tool(spans, 'toolu_n2', 'mcp__fuli__checkpoint_task_knowledge', {'taskContextToken': task_s})
        await host.hook(spans, 'Stop')
        assert (await host.held(spans))['turns'] == []
        recorded = await recorded_texts(spans)
        assert any(token == task_s and 'SYNTHETIC_N2_REPLY' in text for token, text in recorded), recorded
        assert not any('SYNTHETIC_N1_REPLY' in text for _, text in recorded), recorded
        assert any('task ownership was not confirmed' in text for _, text in recorded), recorded

        # 4. Every ledger written is version 2.
        versions = {json.loads(path.read_text()).get('version')
                    for path in (host.runtime.parent / 'transcript-capture').glob('*.json') if path.is_file()}
        assert versions == {2, 3}, versions  # 3 is the newer record the test wrote and FULI left alone
