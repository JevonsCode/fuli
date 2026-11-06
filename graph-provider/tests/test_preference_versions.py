"""A confirmed preference ends the older one of its key and scope, and a
confirmed restatement under a stored preference's ID gets a new version ID
(rec#75). Scripted driver, synthetic rows; needs no graph."""
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from fuli_graph.models import EntityInput
from fuli_graph.preference_versions import end_older_preferences, restated_preferences
from sequential_driver_support import SequentialDriver

SPACE = {'id': 'personal-space', 'kind': 'personal', 'group_id': 'personal-group'}
AT = datetime(2026, 11, 1, tzinfo=timezone.utc)
BASIS = {'existence_reason': 'Synthetic.', 'quadrant_reason': 'Synthetic.',
         'proposed_by': {'kind': 'user'}, 'confirmed_by': {'kind': 'user'}, 'confirmed_at': AT}


def row(item_id, key, *, kind='entity', status='confirmed', attributes='{}', name='Reply language',
        summary='Reply in Chinese', project='alpha'):
    return {'item_kind': kind, 'item_id': item_id, 'key': key, 'attributes_json': attributes, 'name': name,
            'summary': summary, 'preference_scope': 'project', 'preference_project_id': project,
            'preference_agent_id': None, 'confirmation_status': status}


def store(driver):
    return SimpleNamespace(runtime=SimpleNamespace(driver=driver))


@pytest.mark.asyncio
async def test_only_a_same_key_preference_in_the_same_scope_ends_and_its_history_names_the_new_one():
    driver = SequentialDriver([
        [row('new', 'pref-9', attributes='{"preferenceKey":"reply-language"}')],
        [],  # the knowledge lock
        [row('old', 'reply-language', summary='Reply in English'), row('other', 'indent', summary='Use tabs'),
         row('edge', 'pref-3', kind='relationship', attributes='{"preference_key":"reply-language"}')],
        [], [],  # the old entity ends, its revision
        [], [],  # the old relationship ends, its revision
    ])

    ended = await end_older_preferences(store(driver), {'id': 'principal-1'}, SPACE, 'entity', 'new',
                                        changed_by='user', created_at=AT)

    assert ended == [{'item_kind': 'entity', 'item_id': 'old'}, {'item_kind': 'relationship', 'item_id': 'edge'}]
    scan = driver.calls[2][1]
    assert (scan['scope'], scan['project_id'], scan['agent_id']) == ('project', 'alpha', None)
    end, revision = driver.calls[3][1], driver.calls[4][1]
    assert (end['item_id'], end['replaced_by_id'], end['replaced_by_kind']) == ('old', 'new', 'entity')
    assert 'fuli_invalid_at' in driver.calls[3][0] and 'item.invalid_at' in driver.calls[5][0]
    assert revision['action'] == 'supersede'
    assert '"preferenceReplacement": {"preferenceKey": "reply-language"}' in revision['current_json']
    assert '"content": "Reply in English"' in revision['previous_json']


@pytest.mark.asyncio
@pytest.mark.parametrize('found', [[], [row('new', 'reply-language', status='pending')]])
async def test_a_pending_or_missing_preference_ends_nothing(found):
    driver = SequentialDriver([found])

    assert await end_older_preferences(store(driver), {'id': 'principal-1'}, SPACE, 'entity', 'new',
                                       changed_by='user', created_at=AT) == []
    assert len(driver.calls) == 1


def entity(summary, **fields):
    return EntityInput.model_validate({'key': 'reply-language', 'name': 'Reply language', 'type': 'PersonalPreference',
                                       'summary': summary, 'profile_aspect': 'taste', **fields})


@pytest.mark.asyncio
async def test_a_confirmed_restatement_with_other_words_gets_a_new_version_id_the_same_on_replay():
    stored = [row('stored', 'reply-language', summary='Reply in English')]
    changed = entity('Reply in Chinese', confirmation_status='confirmed', confirmation_basis=BASIS)

    first = await restated_preferences(store(SequentialDriver([stored])), SPACE, [changed], ['stored'], 'episode-1')
    replay = await restated_preferences(store(SequentialDriver([stored])), SPACE, [changed], ['stored'], 'episode-1')

    assert set(first) == {'stored'} and first['stored'] != 'stored' and replay == first


@pytest.mark.asyncio
async def test_the_same_words_or_a_pending_restatement_land_on_the_stored_preference():
    stored = [row('stored', 'reply-language', summary='Reply in English')]
    same = entity('Reply in English', confirmation_status='confirmed', confirmation_basis=BASIS)
    driver = SequentialDriver([stored])

    assert await restated_preferences(store(driver), SPACE, [same], ['stored'], 'episode-1') == {}
    pending = SequentialDriver([])
    assert await restated_preferences(store(pending), SPACE, [entity('Reply in Chinese')], ['stored'],
                                      'episode-1') == {}
    assert pending.calls == [], 'a pending restatement needs no read'


@pytest.mark.asyncio
async def test_items_settled_together_read_their_scope_once_and_see_what_the_earlier_ones_ended():
    first, second = row('new-1', 'reply-language'), row('new-2', 'indent', summary='Use spaces')
    older = row('old', 'reply-language', summary='Reply in English')
    driver = SequentialDriver([
        [first], [], [first, second, older, row('tabs', 'indent', summary='Use tabs')],  # read, lock, the scope once
        [], [],  # the old reply language ends, its revision
        [second], [],  # the second item and the lock; its scope is already read
        [], [],  # tabs ends, its revision
    ])
    scopes = {}
    settle = lambda item_id: end_older_preferences(store(driver), {'id': 'principal-1'}, SPACE, 'entity', item_id,
                                                   changed_by='user', created_at=AT, scopes=scopes)

    assert await settle('new-1') == [{'item_kind': 'entity', 'item_id': 'old'}]
    assert await settle('new-2') == [{'item_kind': 'entity', 'item_id': 'tabs'}]
    assert sum('= $scope' in query for query, _ in driver.calls) == 1
    assert [item['item_id'] for item in scopes[('project', 'alpha', None)]] == ['new-1', 'new-2']
