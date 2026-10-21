"""The installed Codex hook against the real HTTP Provider and a disposable Neo4j.

rec#28: Codex's hook input defines no isMeta or is_meta (openai/codex
deede7201da2: codex-rs/hooks/src/schema.rs 566-584), so a turn marked that way
has an unprovable source. It re-reads the current task in place after the
session-off check, is held as unresolved, and its Stop neither settles that
task nor records the turn under it, until another task, or none, is current or
a fresh task entry ends it. No Codex turn is proven an explicit continuation.
Every hook call is its own Node process, as Codex runs it; the state between
calls is only what FULI persists (the Provider, the capture ledger, the hold
store) and the synthetic rollout this test writes as the host. Codex runs
UserPromptSubmit before it records the prompt, so the host writes it after.
Synthetic identities and payloads only; no model, client or real transcript.
"""
import json

import pytest

from test_claude_hook_refresh_neo4j import Host, NO_VALID, _recorded, _set_preference, claude_host, token_of

UNCONFIRMED = 'Codex 的 hook 输入不定义这个字段'
MARKED = 'Synthetic marked delivery.'


class CodexHost(Host):
    """A synthetic Codex host: a rollout that begins with its session_meta, and the hook before the prompt is recorded."""
    source = 'codex'

    def write(self, session, record):
        path = self.transcript(session)
        header = '' if path.exists() else json.dumps({'type': 'session_meta', 'payload': {'id': session}}) + '\n'
        with path.open('a', encoding='utf-8') as file:
            file.write(header + json.dumps(record, ensure_ascii=False) + '\n')

    def message(self, session, role, text):
        self.write(session, {'type': 'response_item', 'payload': {'type': 'message', 'role': role,
            'content': [{'type': 'input_text' if role == 'user' else 'output_text', 'text': text}]}})

    def user(self, session, text):
        self.message(session, 'user', text)

    def reply(self, session, text):
        self.message(session, 'assistant', text)

    async def hook(self, session, event, **fields):
        if not self.transcript(session).exists():
            self.write(session, {'type': 'turn_context', 'payload': {}})
        return await super().hook(session, event, **fields)

    async def prompt(self, session, text, **fields):
        output = await self.hook(session, 'UserPromptSubmit', prompt=text, **fields)
        if output.get('decision') != 'block':
            self.user(session, text)
        return (output.get('hookSpecificOutput') or {}).get('additionalContext', '')

    async def marked_turn(self, session, reply, **mark):
        context = await self.prompt(session, MARKED, **(mark or {'isMeta': True}))
        self.reply(session, reply)
        return context


async def _texts(settings, session):
    return [content for _, content in await _recorded(settings, session)]


async def _nothing_recorded(settings, session, *replies):
    texts = await _texts(settings, session)
    for reply in replies:
        assert not any(reply in text for text in texts), (reply, texts)


@pytest.mark.asyncio
async def test_codex_marked_turns_refresh_in_place_and_never_settle_or_record_under_the_task(tmp_path):
    async with claude_host(tmp_path, CodexHost) as (host, settings, space):
        session = host.sid('synthetic-codex-refresh-a')
        task_a = await host.unfinished_task(session, 'Synthetic task A: build the sample in the background.')

        # A mid-run preference change reaches the next marked turn, which refreshes A in place.
        revision = 1
        for label, mark in [('isMeta', {'isMeta': True}), ('is_meta', {'is_meta': True})]:
            revision += 1
            await _set_preference(settings, space, revision)
            context = await host.marked_turn(session, f'SYNTHETIC_{label.upper()}_REPLY', **mark)
            assert UNCONFIRMED in context and "is not this turn's confirmed task" in context, context
            assert f'Synthetic preference revision {revision}' in context, context
            assert f'Synthetic preference revision {revision - 1}' not in context
            assert token_of(context) == task_a
            assert 'not a new user task' not in context
            await host.stops_settle_nothing(session, label, token=task_a)
        await _nothing_recorded(settings, session, MARKED, 'SYNTHETIC_ISMETA_REPLY', 'SYNTHETIC_IS_META_REPLY')
        assert any('task ownership was not confirmed' in text for text in await _texts(settings, session))

        # Unfinished A can still be checkpointed explicitly; that proves nothing about the held turn.
        await host.run('checkpoint', {'token': task_a})
        assert (await host.current(session))['checkpoint'] == 'complete'
        await host.stops_settle_nothing(session, 'A checkpointed', token=task_a, checkpoint='complete')
        # The checkpoint change is visible on the next marked turn: no valid task context, no token.
        closed = await host.marked_turn(session, 'SYNTHETIC_AFTER_CLOSE_REPLY')
        assert NO_VALID in closed and 'the current task of this session is closed' in closed and 'fuli-task-' not in closed

        # An explicit new task B enters normally, gets its own token and is settled by its own Stop.
        entered = await host.prompt(session, 'Synthetic task B: write the release note.')
        task_b = token_of(entered)
        assert task_b and task_b != task_a and UNCONFIRMED not in entered, entered
        held = await host.held(session)
        assert held['turns'] == [] and not held['unprovable'], held
        host.reply(session, 'SYNTHETIC_TASK_B_REPLY')
        await host.hook(session, 'Stop')
        current = await host.current(session)
        assert current['token'] == task_b and current['checkpoint'] == 'complete', current
        recorded = await _recorded(settings, session)
        assert any(token == task_b and 'SYNTHETIC_TASK_B_REPLY' in text for token, text in recorded), recorded
        await _nothing_recorded(settings, session, MARKED, 'SYNTHETIC_ISMETA_REPLY', 'SYNTHETIC_IS_META_REPLY',
                                'SYNTHETIC_AFTER_CLOSE_REPLY')

        # Resume and compaction refresh A2's preferences; they and every other reset leave the turn held.
        restart = host.sid('synthetic-codex-refresh-restart')
        task_r = await host.unfinished_task(restart, 'Synthetic task A2: watch the deploy.')
        await host.marked_turn(restart, 'SYNTHETIC_BEFORE_RESET_REPLY')
        await host.stops_settle_nothing(restart, 'before reset', token=task_r)
        await _set_preference(settings, space, 9)
        for source in ['resume', 'compact']:
            output = await host.hook(restart, 'SessionStart', source=source)
            context = (output.get('hookSpecificOutput') or {}).get('additionalContext', '')
            assert 'Synthetic preference revision 9' in context and token_of(context) == task_r, (source, output)
            host.reply(restart, f'SYNTHETIC_AFTER_{source.upper()}_REPLY')
            await host.stops_settle_nothing(restart, source, token=task_r)
        for label, event, fields in [('startup', 'SessionStart', {'source': 'startup'}),
                                     ('clear', 'SessionStart', {'source': 'clear'}),
                                     ('compaction', 'PreCompact', {'trigger': 'auto'})]:
            await host.hook(restart, event, **fields)
            host.reply(restart, f'SYNTHETIC_AFTER_{label.upper()}_REPLY')
            await host.stops_settle_nothing(restart, label, token=task_r)
        texts = await _texts(settings, restart)
        assert not any('SYNTHETIC_BEFORE_RESET_REPLY' in text or 'SYNTHETIC_AFTER_' in text for text in texts), texts

        # FULI off for the session: the marked turn reads and injects nothing, and the turn stays held.
        off = host.sid('synthetic-codex-refresh-off')
        task_o = await host.unfinished_task(off, 'Synthetic task A3: run the migration check.')
        await host.hook(off, 'UserPromptSubmit', prompt='/fuli stop')
        context = await host.marked_turn(off, 'SYNTHETIC_WHILE_OFF_REPLY')
        assert 'FULI is stopped for this session by the person' in context, context
        assert task_o not in context and 'Synthetic preference revision' not in context and UNCONFIRMED not in context
        await host.stops_settle_nothing(off, 'FULI off', token=task_o)
        await _nothing_recorded(settings, off, 'SYNTHETIC_WHILE_OFF_REPLY')

        # No current task: none is established, no token shown, nothing created.
        empty = host.sid('synthetic-codex-refresh-empty')
        await host.hook(empty, 'UserPromptSubmit', prompt='/fuli start')
        context = await host.marked_turn(empty, 'SYNTHETIC_NO_TASK_REPLY')
        assert NO_VALID in context and 'this session has no current task' in context and 'fuli-task-' not in context
        assert await host.current(empty) is None


@pytest.mark.asyncio
async def test_codex_marked_turns_stay_held_when_their_state_cannot_be_kept(tmp_path):
    async with claude_host(tmp_path, CodexHost) as (host, settings, space):
        # The ledger cannot be written: the turn is kept in its own hold and Stops settle nothing.
        unwritable = host.sid('synthetic-codex-held-unwritable')
        task_w = await host.unfinished_task(unwritable, 'Synthetic task: ledger cannot be written.')
        host.ledger_path(unwritable).unlink(missing_ok=True)
        host.ledger_path(unwritable).mkdir(parents=True)
        await host.marked_turn(unwritable, 'SYNTHETIC_UNWRITABLE_REPLY')
        assert host.ledger_path(unwritable, 'transcript-turn-holds').exists(), 'the turn is kept in its own hold'
        await host.stops_settle_nothing(unwritable, 'ledger write failure', token=task_w)
        await _nothing_recorded(settings, unwritable, 'SYNTHETIC_UNWRITABLE_REPLY')
        host.ledger_path(unwritable).rmdir()
        # A fresh entry proves the state again; the new task starts and settles normally.
        task_w2 = token_of(await host.prompt(unwritable, 'Synthetic next task after recovery.'))
        assert task_w2 and task_w2 != task_w
        host.reply(unwritable, 'SYNTHETIC_RECOVERED_REPLY')
        await host.hook(unwritable, 'Stop')
        current = await host.current(unwritable)
        assert current['token'] == task_w2 and current['checkpoint'] == 'complete', current
        recorded = await _recorded(settings, unwritable)
        assert any(token == task_w2 and 'SYNTHETIC_RECOVERED_REPLY' in text for token, text in recorded), recorded
        await _nothing_recorded(settings, unwritable, 'SYNTHETIC_UNWRITABLE_REPLY', MARKED)

        # Nowhere to keep it: the message is held back with the cause and the recovery, and A is unchanged.
        nowhere = host.sid('synthetic-codex-held-nowhere')
        task_n = await host.unfinished_task(nowhere, 'Synthetic task: nothing can be written.')
        for directory in ['transcript-capture', 'transcript-turn-holds']:
            path = host.ledger_path(nowhere, directory)
            path.unlink(missing_ok=True)
            path.mkdir(parents=True)
        blocked = await host.hook(nowhere, 'UserPromptSubmit', prompt=MARKED, isMeta=True)
        reason = blocked.get('reason', '')
        assert blocked.get('decision') == 'block' and 'held this message back' in reason, blocked
        assert 'it carries an isMeta mark that Codex does not define' in reason and '它带有 Codex 不定义的 isMeta 标记' in reason
        assert 'transcript-turn-holds/' in reason and 'resend the message yourself' in reason and 'FULI 不会自动重发' in reason
        assert (await host.current(nowhere))['token'] == task_n

        # Every ledger written is version 2.
        versions = {json.loads(path.read_text()).get('version')
                    for path in (host.runtime.parent / 'transcript-capture').glob('*.json') if path.is_file()}
        assert versions == {2}, versions
