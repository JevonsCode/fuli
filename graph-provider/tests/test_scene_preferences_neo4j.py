"""rec#15 D-27 against an explicitly disposable Neo4j: what remember commits
(constraint and scene qualifiers in the entity attributes) survives capture
and a person's confirmation, and the task scene selects from it. Synthetic
preferences only; public HTTP routes drive every write."""

import pytest

from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_turn_receipt_neo4j import commit, confirm, ok, preference, space_with_projects

# The entity shapes test/scene-preference-entry.test.js shows remember producing.
HARD = preference('hard', 'Never force-push a shared branch, in any scene.',
                  profile_aspect='judgment_preference', attributes={'constraint': 'hard'})
FRONTEND = preference('grid', 'Settings pages use the 8px grid.',
                      attributes={'workKind': 'frontend', 'tasteDomain': 'design'})
# An older FULI's confirmed judgment rule: no scene key, no marker.
BOUNDARY = preference('boundary', '未经批准不要强推共享分支', profile_aspect='judgment_preference')
GENERAL = preference('tone', 'State the tradeoff in one line.', profile_aspect='personality')


async def scene(client, space_id, **task):
    return ok(await client.get('/v1/collaboration-preferences', params={
        'personal_space_id': space_id, 'personal_project_id': 'alpha',
        'session_id': 'synthetic-session', **task}))


@pytest.mark.asyncio
async def test_confirmed_remember_qualifiers_are_stored_and_select_by_scene():
    settings = fixture_settings()
    async with provider_client(settings) as (client, _):
        space_id = await space_with_projects(client, 'alpha')
        saved = await commit(client, space_id, [HARD, FRONTEND, BOUNDARY, GENERAL])
        for item_id in saved['entity_ids']:
            await confirm(client, space_id, item_id)

        def keys(result):
            return sorted(item['title'] for item in result['effective_preferences'])

        everything = [HARD['name'], FRONTEND['name'], BOUNDARY['name'], GENERAL['name']]
        frontend = await scene(client, space_id, work_kind='frontend')
        assert keys(frontend) == sorted(everything)
        stored = {item['title']: item['preference_qualifiers']
                  for item in frontend['effective_preferences']}
        assert stored[HARD['name']] == {'constraint': 'hard'}
        assert stored[FRONTEND['name']] == {'workKind': 'frontend', 'tasteDomain': 'design'}

        chat = await scene(client, space_id, work_kind='chat')
        assert keys(chat) == sorted([HARD['name'], BOUNDARY['name']])
        assert chat['scope_unknown'] == []

        unclassified = await scene(client, space_id)
        assert keys(unclassified) == sorted([HARD['name'], BOUNDARY['name'], GENERAL['name']])
        [unknown] = unclassified['scope_unknown']
        assert unknown in {item['preference_key'] for item in frontend['effective_preferences']
                           if item['title'] == FRONTEND['name']}
