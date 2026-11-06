"""A corrected preference replaces the old one (rec#75), against an explicitly
disposable Neo4j. A person confirms a preference written under the key of a
current one in the same scope: the old one ends where the new one starts,
links to it and keeps its words as history, and delivery and search answer
with the new one only. Synthetic preferences only; public HTTP routes drive
every write."""

import pytest

from test_keyed_supersession_neo4j import revisions, search
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_turn_receipt_neo4j import applied, commit, confirm, preference, space_with_projects, view

PERSON = {'existence_reason': 'The person corrected it.', 'quadrant_reason': 'Stated directly.',
          'proposed_by': {'kind': 'user', 'label': 'Synthetic user'},
          'confirmed_by': {'kind': 'user', 'label': 'Synthetic user'},
          'confirmed_at': '2026-11-01T00:00:00Z'}


def confirmed(key, text, **fields):
    return preference(key, text, confirmation_status='confirmed', confirmation_basis=PERSON, **fields)


@pytest.mark.asyncio
async def test_a_confirmed_capture_under_the_same_key_replaces_the_preference_and_keeps_history():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        [old_id] = (await commit(client, space_id, [confirmed('reply-language', 'Reply in English')],
                                 project='alpha'))['entity_ids']
        assert old_id in await applied(client, space_id, 'alpha')

        saved = await commit(client, space_id, [confirmed('reply-language', 'Reply in Chinese')], project='alpha')
        [new_id] = saved['entity_ids']
        assert new_id != old_id, 'the correction is a new version, not the old item unchanged'
        assert saved['superseded'] == [{'item_kind': 'entity', 'item_id': old_id}]

        delivered = await applied(client, space_id, 'alpha')
        assert new_id in delivered and old_id not in delivered
        old = await view(client, space_id, old_id)
        assert old['status'] == 'superseded' and old['content'] == 'Reply in English'
        [ended] = revisions(old, 'supersede')
        assert ended['current']['replacedByItemId'] == new_id
        assert ended['current']['preferenceReplacement'] == {'preferenceKey': 'reply-language'}

        # Found by its key; history only when asked for.
        _, entities = await search(client, space_id, 'reply-language')
        assert new_id in entities and old_id not in entities
        _, entities = await search(client, space_id, 'reply language', include_historical=True)
        assert entities[old_id]['invalid_at'] is not None and entities[new_id]['invalid_at'] is None


@pytest.mark.asyncio
async def test_a_pending_correction_waits_and_the_persons_confirmation_replaces_the_stated_key():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha', 'beta')
        [old_id] = (await commit(client, space_id, [confirmed('pref-1', 'Tabs for indentation',
                                                              attributes={'preferenceKey': 'indent'})],
                                 project='alpha'))['entity_ids']
        [beta_id] = (await commit(client, space_id, [confirmed('indent', 'Tabs in beta')], project='beta'))['entity_ids']

        # An Agent's correction under the stated key waits for the person.
        [new_id] = (await commit(client, space_id, [preference('indent', 'Two spaces for indentation')],
                                 project='alpha'))['entity_ids']
        assert old_id in await applied(client, space_id, 'alpha')

        await confirm(client, space_id, new_id)
        delivered = await applied(client, space_id, 'alpha')
        assert new_id in delivered and old_id not in delivered
        assert (await view(client, space_id, old_id))['status'] == 'superseded'
        # The same key in another project is another preference.
        assert (await view(client, space_id, beta_id))['status'] == 'current'
