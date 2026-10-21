"""A person's graph migration against a disposable loopback Neo4j (rec#17
D-09 part 2): preview, apply, undo, a stale preview, a concurrent apply, an
interrupted apply and the human-review channel. Every graph is synthetic;
like test_graph_format_neo4j.py these tests empty the database and run only
with FULI_TEST_NEO4J_RESETTABLE=1.
"""

import asyncio
from dataclasses import replace

import pytest

from fuli_graph import graph_format_confirm
from fuli_graph.graph_format_migrations import GRAPH_FORMAT_VERSION
from test_graph_format_neo4j import (  # noqa: F401 - graph is a fixture
    ACCESS_TOKEN,
    _events,
    _rows,
    _seed_legacy_principal,
    _version,
    graph,
)
from test_project_agent_memory_neo4j import provider_client

REVIEW_TOKEN = 'synthetic-human-review-token-0123456789abcdef'
GROUP_STEP = 'graph/9-group-id-separators'
# Knowledge written by a FULI that already kept usage and inheritance.
LIFECYCLE = {
    'fuli_utility_score': 0.0, 'fuli_confidence_score': 0.5, 'fuli_qualified_use_count': 0,
    'fuli_distinct_task_count': 0, 'fuli_usage_generation': 1,
    'fuli_inheritance_mode': 'local_only', 'fuli_inherited_project_ids': [],
}
RELEASE_STEP = 'graph/8-project-release-records'


def _reviewed(settings):
    return settings.model_copy(update={'human_review_token': REVIEW_TOKEN})


async def _seed_colon_groups(driver):
    """A space an earlier FULI named with ':' and knowledge filed under it."""
    await _seed_legacy_principal(driver)
    await driver.execute_query(
        '''
        MATCH (s:FuliSpace {id: 'legacy-space'}) SET s.group_id = 'legacy:personal:legacy-space'
        CREATE (a:Entity {uuid: 'entity-a', name: 'Synthetic secret entity',
                          group_id: 'legacy:personal:legacy-space'})
        CREATE (b:Entity {uuid: 'entity-b', name: 'Synthetic other entity',
                          group_id: 'legacy:personal:legacy-space'})
        CREATE (a)-[r:RELATES_TO {uuid: 'fact-ab', fact: 'Synthetic secret fact',
                                   group_id: 'legacy:personal:legacy-space'}]->(b)
        WITH a, b, r
        UNWIND [a, b, r] AS item
        SET item += $lifecycle
        ''',
        lifecycle=LIFECYCLE,
    )


async def _groups(driver):
    rows = await _rows(driver, '''
        MATCH (n) WHERE n.group_id IS NOT NULL RETURN 'node:' + coalesce(n.uuid, n.id) AS key, n.group_id AS g
        UNION ALL
        MATCH ()-[r]->() WHERE r.group_id IS NOT NULL RETURN 'rel:' + r.uuid AS key, r.group_id AS g
    ''')
    return {row['key']: row['g'] for row in rows}


REVIEW = {'x-fuli-human-review-token': REVIEW_TOKEN}


@pytest.mark.asyncio
async def test_preview_apply_and_undo_a_record_step_through_the_human_review_channel(graph):
    settings, driver = graph
    await _seed_colon_groups(driver)
    before = await _groups(driver)

    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        preview = (await client.post('/v1/data-format/preview')).json()
        plan = preview['plan']
        assert plan['action'] == 'apply' and plan['undo'] == 'available'
        assert plan['step']['id'] == GROUP_STEP
        assert plan['step']['count'] == 1 and plan['step']['sampleIds'] == ['legacy-space']
        assert 'secret' not in str(preview)
        assert await _groups(driver) == before

        unreviewed = await client.post('/v1/data-format/apply',
                                       json={'digest': plan['digest'], 'entrypoint': 'cli'})
        assert unreviewed.status_code == 403
        applied = await client.post('/v1/data-format/apply', headers=REVIEW,
                                    json={'digest': plan['digest'], 'entrypoint': 'cli'})
        assert applied.status_code == 200, applied.text
        body = applied.json()
        assert body['status'] == 'applied' and body['data_format']['state'] == 'current'
        assert set((await _groups(driver)).values()) == {'legacy-personal-legacy-space'}
        assert await _version(driver) == GRAPH_FORMAT_VERSION
        written = await client.post('/v1/spaces', json={'name': 'Writable again', 'kind': 'personal'})
        assert written.status_code == 200, written.text
        assert (await client.post('/v1/data-format/preview')).json()['undoable'][0]['migrationId'] == GROUP_STEP

        undone = await client.post('/v1/data-format/rollback', headers=REVIEW,
                                   json={'migration_id': GROUP_STEP, 'entrypoint': 'http'})
        assert undone.status_code == 200, undone.text
        assert undone.json()['data_format']['state'] == 'pending_confirmation'
        refused = await client.post('/v1/spaces', json={'name': 'Refused', 'kind': 'personal'})
        assert refused.status_code == 503

    groups = await _groups(driver)
    assert {key: groups[key] for key in before} == before
    assert await _version(driver) == 8
    statuses = [e['status'] for e in await _events(driver) if e['id'] == GROUP_STEP]
    assert statuses[-3:] == ['applied', 'rolled_back', 'pending_confirmation']


@pytest.mark.asyncio
async def test_a_stale_preview_changes_nothing(graph):
    settings, driver = graph
    await _seed_colon_groups(driver)

    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
        await driver.execute_query(
            "CREATE (:FuliSpace {id: 'late-space', kind: 'project', group_id: 'late:project:x'})"
        )
        before = await _groups(driver)
        stale = await client.post('/v1/data-format/apply', headers=REVIEW,
                                  json={'digest': plan['digest'], 'entrypoint': 'cli'})

    assert stale.status_code == 409
    assert stale.json()['detail']['code'] == 'data_format_stale_preview'
    assert await _groups(driver) == before
    assert await _rows(driver, 'MATCH (u:FuliDataFormatUndo) RETURN count(u) AS n') == [{'n': 0}]
    assert 'applied' not in [e['status'] for e in await _events(driver) if e['id'] == GROUP_STEP]


@pytest.mark.asyncio
async def test_two_concurrent_applies_run_the_step_once(graph):
    settings, driver = graph
    await _seed_colon_groups(driver)

    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
        body = {'digest': plan['digest'], 'entrypoint': 'cli'}
        first, second = await asyncio.gather(
            client.post('/v1/data-format/apply', headers=REVIEW, json=body),
            client.post('/v1/data-format/apply', headers=REVIEW, json=body),
        )

    assert sorted([first.json()['status'], second.json()['status']]) == ['already_applied', 'applied']
    applied = [e for e in await _events(driver) if e['id'] == GROUP_STEP and e['status'] == 'applied']
    assert len(applied) == 1
    headers = await _rows(driver, "MATCH (u:FuliDataFormatUndo {kind: 'apply'}) RETURN count(u) AS n")
    assert headers == [{'n': 1}]


@pytest.mark.asyncio
async def test_an_interrupted_apply_changes_nothing_and_runs_again(graph, monkeypatch):
    settings, driver = graph
    await _seed_colon_groups(driver)
    before = await _groups(driver)
    migration = graph_format_confirm._MIGRATIONS[GROUP_STEP]

    async def power_cut(queries, step_settings):
        await migration.apply(queries, step_settings)
        raise RuntimeError('power cut')

    async with provider_client(_reviewed(settings), ACCESS_TOKEN, raise_app_exceptions=False) as (client, _):
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
        body = {'digest': plan['digest'], 'entrypoint': 'cli'}
        monkeypatch.setitem(graph_format_confirm._MIGRATIONS, GROUP_STEP, replace(migration, apply=power_cut))
        interrupted = await client.post('/v1/data-format/apply', headers=REVIEW, json=body)
        assert interrupted.status_code == 500
        assert await _groups(driver) == before
        assert await _rows(driver, 'MATCH (u:FuliDataFormatUndo) RETURN count(u) AS n') == [{'n': 0}]
        monkeypatch.setitem(graph_format_confirm._MIGRATIONS, GROUP_STEP, migration)
        rerun = await client.post('/v1/data-format/apply', headers=REVIEW, json=body)

    assert rerun.status_code == 200, rerun.text
    assert set((await _groups(driver)).values()) == {'legacy-personal-legacy-space'}


@pytest.mark.asyncio
async def test_undo_is_refused_once_a_migrated_record_changed(graph):
    settings, driver = graph
    await _seed_colon_groups(driver)

    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
        await client.post('/v1/data-format/apply', headers=REVIEW,
                          json={'digest': plan['digest'], 'entrypoint': 'cli'})
        await driver.execute_query("MATCH (e:Entity {uuid: 'entity-b'}) SET e.group_id = 'moved-later'")
        before = await _groups(driver)
        refused = await client.post('/v1/data-format/rollback', headers=REVIEW,
                                    json={'migration_id': GROUP_STEP, 'entrypoint': 'cli'})

    assert refused.status_code == 409
    detail = refused.json()['detail']
    assert detail['code'] == 'data_format_changed_since'
    assert '1 records changed' in detail['message'] and 'graph import' in detail['message']
    assert await _groups(driver) == before
    assert await _version(driver) == GRAPH_FORMAT_VERSION


@pytest.mark.asyncio
async def test_undo_removes_the_records_a_step_created(graph):
    settings, driver = graph
    await _seed_legacy_principal(driver)
    # Published before releases existed, at the version just before graph/8.
    await driver.execute_query(
        '''
        MATCH (p:FuliPrincipal {id: 'legacy-principal'})
        CREATE (p)-[:OWNS]->(:FuliSpace {id: 'public-project', kind: 'project', visibility: 'public',
                                        name: 'Synthetic public project', group_id: 'public-project',
                                        created_at: datetime('2026-01-02T00:00:00Z')})
        MERGE (f:FuliDataFormat {store: 'graph'}) SET f.version = 7
        '''
    )

    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
        assert plan['step']['id'] == RELEASE_STEP and plan['step']['sampleIds'] == ['public-project']
        applied = await client.post('/v1/data-format/apply', headers=REVIEW,
                                    json={'digest': plan['digest'], 'entrypoint': 'cli'})
        assert applied.status_code == 200, applied.text
        assert await _rows(driver, 'MATCH (r:FuliProjectRelease) RETURN r.id AS id') == [
            {'id': 'legacy-release-public-project'}]
        undone = await client.post('/v1/data-format/rollback', headers=REVIEW,
                                   json={'migration_id': RELEASE_STEP, 'entrypoint': 'cli'})
        assert undone.status_code == 200, undone.text

    assert await _rows(driver, 'MATCH (r:FuliProjectRelease) RETURN count(r) AS n') == [{'n': 0}]
    space = await _rows(driver, "MATCH (s:FuliSpace {id: 'public-project'}) RETURN properties(s) AS p")
    assert 'release_version' not in space[0]['p'] and 'updated_at' not in space[0]['p']
    assert await _version(driver) == 7
