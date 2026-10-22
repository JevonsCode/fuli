"""rec#16: a capture window that expires keeps on-period history, on the real HTTP Provider and a disposable Neo4j.

1. An entry whose window expires in its handoff still enters its task. The entered
   task's Stop finishes the handoff: the new prompt and reply are recorded under the
   new task, and an old tail the entry could not flush is one content-free omission.
2. A Stop whose window expires just before recording is switched off: the next hook
   imports that on-period turn under its task, and only the bytes written after it
   are marked as written while recording was off.

The forced deadline is a Provider request that never answers (the driver's
expireAt), so the window expires at that request without depending on load.
Every hook call is its own Node process. Synthetic identities and payloads only.
"""
import re

import pytest

from test_claude_hook_refresh_neo4j import _recorded, claude_host, token_of

OMITTED = 'unverified task ownership after fallback'
OFF = re.compile(r'^\[Not recorded: automatic recording was off \(global_off\); native bytes (\d+) to (\d+)')


async def _task(host, session, text, **fields):
    entered = await host.prompt(session, text, **fields)
    token = token_of(entered)
    assert token, entered
    return token


@pytest.mark.asyncio
async def test_an_entry_whose_window_expires_is_finished_by_the_entered_tasks_stop(tmp_path):
    async with claude_host(tmp_path) as (host, settings, _space):
        session = host.sid('synthetic-window-entry')
        await host.hook(session, 'UserPromptSubmit', prompt='/fuli start')
        task_a = await _task(host, session, 'Synthetic task A: list the sample files.')
        host.reply(session, 'SYNTHETIC_A_REPLY')
        await host.hook(session, 'Stop')

        # The old task's tail page (empty here) is the request that never answers.
        task_b = await _task(host, session, 'Synthetic task B: rename the sample file.', expireAt='append')
        assert task_b != task_a
        host.reply(session, 'SYNTHETIC_B_REPLY')
        await host.hook(session, 'Stop')
        recorded = await _recorded(settings, session)
        assert (task_b, 'Synthetic task B: rename the sample file.') in recorded, recorded
        assert any(token == task_b and 'SYNTHETIC_B_REPLY' in text for token, text in recorded), recorded
        assert not any(OMITTED in text for _, text in recorded), 'nothing of task A was left unflushed'

        # Task C's reply is never synced by its own Stop; D's entry has to flush it and expires on that page.
        tail = host.sid('synthetic-window-entry-tail')
        await host.hook(tail, 'UserPromptSubmit', prompt='/fuli start')
        task_c = await _task(host, tail, 'Synthetic task C: draft the sample note.')
        host.reply(tail, 'SYNTHETIC_C_UNFLUSHED_REPLY')
        task_d = await _task(host, tail, 'Synthetic task D: review the sample note.', expireAt='append')
        assert task_d != task_c
        host.reply(tail, 'SYNTHETIC_D_REPLY')
        await host.hook(tail, 'Stop')
        recorded = await _recorded(settings, tail)
        assert not any('SYNTHETIC_C_UNFLUSHED_REPLY' in text for _, text in recorded), recorded
        assert [token for token, text in recorded if OMITTED in text] == [task_d], recorded
        assert (task_d, 'Synthetic task D: review the sample note.') in recorded, recorded
        assert any(token == task_d and 'SYNTHETIC_D_REPLY' in text for token, text in recorded), recorded
        for directory in ['transcript-guards']:
            assert not list((host.runtime.parent / directory).glob('*.json')), 'every handoff is finished'


@pytest.mark.asyncio
async def test_a_stop_that_expires_before_recording_goes_off_keeps_its_turn(tmp_path):
    async with claude_host(tmp_path) as (host, settings, _space):
        session = host.sid('synthetic-window-stop')
        await host.hook(session, 'UserPromptSubmit', prompt='/fuli start')
        task_a = await _task(host, session, 'Synthetic task A: check the sample build.')
        host.reply(session, 'SYNTHETIC_ON_REPLY')
        # The Stop's read of the session cursor never answers.
        await host.hook(session, 'Stop', expireAt='session')
        on_end = host.transcript(session).stat().st_size
        await host.run('capture', {'enabled': False, 'disabledSources': []})
        host.user(session, 'SYNTHETIC_PRIVATE_PROMPT')
        await host.hook(session, 'UserPromptSubmit', prompt='SYNTHETIC_PRIVATE_PROMPT')
        host.reply(session, 'SYNTHETIC_PRIVATE_REPLY')
        await host.hook(session, 'Stop')
        await host.run('capture', {'enabled': True, 'disabledSources': []})

        recorded = await _recorded(settings, session)
        assert any(token == task_a and 'SYNTHETIC_ON_REPLY' in text for token, text in recorded), recorded
        assert not any('SYNTHETIC_PRIVATE' in text for _, text in recorded), recorded
        off = [OFF.match(text) for _, text in recorded if OFF.match(text)]
        assert off, recorded
        assert all(int(match.group(1)) >= on_end for match in off), (on_end, [match.group(0) for match in off])
