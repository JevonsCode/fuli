"""What a follower holds as its copy of `global`, read only
(scope_replica_summary.py), on a disposable Neo4j through the full Provider app.

The summary's digest is the one the host's export gives for the same records,
and the one the import answers for what it wrote; it changes when the copy is
imported anew and when a copy changes here. Synthetic data only.

Requires FULI_TEST_NEO4J_URI and FULI_TEST_NEO4J_EPHEMERAL=1.
"""
import pytest

from fuli_graph.provider_values import graphiti_group_id
from fuli_graph.scope_export import content_digest
from test_follower_space_neo4j import (  # noqa: F401
    alone, follower_settings, host_global, no_personal_space, strict, take_space,
)
from test_project_agent_memory_neo4j import fixture_settings, provider_client
from test_scope_export_neo4j import checked, cleanup
from test_scope_import_neo4j import OWNER, import_envelope, retouched, scenario


async def summary(client, space_id):
    return await checked(await client.get('/v1/scopes/replica-summary', params={
        'personal_space_id': space_id, 'scope': 'global'}))


def exported_digest(envelope):
    """The digest of the host's export of the same records, from the envelope itself."""
    return content_digest(
        [(entry['id'], entry['labels'], entry['properties']) for entry in envelope['nodes']],
        [(entry['type'], entry['start'], entry['end'], entry['properties']) for entry in envelope['relationships']])


@pytest.mark.asyncio
async def test_the_summary_says_what_the_import_wrote_and_changes_with_the_copy(alone, strict):  # noqa: F811
    settings = fixture_settings()
    space_id, envelope = await host_global(settings)
    group = graphiti_group_id(settings.provider_id, 'personal', space_id)
    async with provider_client(follower_settings()) as (client, _):
        driver = await no_personal_space(client)
        try:
            await take_space(client, space_id, settings.provider_id)
            before = await summary(client, space_id)
            assert (before['copiedRecords'], before['syncedAt'], before['owners']) == (0, None, [])
            imported = await import_envelope(client, envelope)
            assert imported['dangling']['count'] == 0
            held = await summary(client, space_id)
            assert held['contentDigest'] == imported['contentDigest'] == exported_digest(envelope)
            assert held['copiedRecords'] == len(envelope['nodes']) + len(envelope['relationships'])
            assert held['owners'] == [OWNER]
            assert held['syncedAt'] is not None
            assert await summary(client, space_id) == held, 'reading it writes nothing'

            # The host changed a habit: the next import gives a new digest, and the summary follows.
            habit = f'Entity:{space_id}-pref-global'

            def renamed(changed):
                entry = next(item for item in changed['nodes'] if item['id'] == habit)
                entry['properties']['name'] = 'Synthetic tables over prose, v2'
            changed = retouched(envelope, renamed)
            again = await import_envelope(client, changed)
            moved = await summary(client, space_id)
            assert moved['contentDigest'] == again['contentDigest'] == exported_digest(changed)
            assert moved['contentDigest'] != held['contentDigest']
            assert moved['syncedAt'] >= held['syncedAt']

            # A copy changed here (past every refusal): the summary no longer matches the import.
            await driver.maintenance().execute_query(
                "MATCH (habit:Entity {uuid: $uuid}) SET habit.summary = 'Changed here'", uuid=f'{space_id}-pref-global')
            assert (await summary(client, space_id))['contentDigest'] != again['contentDigest']
        finally:
            await cleanup(driver.maintenance(), space_id, group)


@pytest.mark.asyncio
async def test_a_graph_without_copies_holds_none(alone):  # noqa: F811
    async with provider_client(fixture_settings()) as (client, _):
        await no_personal_space(client)
        driver, space, group = await scenario(client)
        try:
            held = await summary(client, space)
            assert (held['copiedRecords'], held['syncedAt'], held['owners']) == (0, None, [])
            assert held['contentDigest'] == content_digest([], [])
        finally:
            await cleanup(driver, space, group)
