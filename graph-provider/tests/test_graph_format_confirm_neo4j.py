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
from fuli_graph.graph_format import GraphFormatState, GraphFormatUnavailable
from fuli_graph.runtime import ManagedNeo4jDriver
from fuli_graph.graph_format_journal import journal_inventory
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
        assert plan['step']['count'] == 4 and len(plan['step']['sampleIds']) == 4
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


def _maintenance(settings):
    """The provider's own unguarded handle, outside any app."""
    driver = ManagedNeo4jDriver(uri=settings.neo4j_uri, user=settings.neo4j_user,
                                password=settings.neo4j_password, database=settings.neo4j_database)
    return driver, driver.maintenance()


@pytest.mark.asyncio
async def test_the_plan_binds_every_renamed_record_so_a_later_one_makes_it_stale(graph):
    settings, driver = graph
    await _seed_colon_groups(driver)

    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
        # The space, two entities and their relationship: what the step rewrites.
        assert plan['step']['count'] == 4
        assert all(key.startswith('rename:') and key.endswith('->legacy-personal-legacy-space')
                   for key in plan['step']['sampleIds'])
        # Filed under the old group after the preview, in the same space.
        await driver.execute_query(
            "CREATE (:Entity {uuid: 'entity-late', group_id: 'legacy:personal:legacy-space'})"
        )
        stale = await client.post('/v1/data-format/apply', headers=REVIEW,
                                  json={'digest': plan['digest'], 'entrypoint': 'cli'})
        again = (await client.post('/v1/data-format/preview')).json()['plan']

    assert stale.status_code == 409 and stale.json()['detail']['code'] == 'data_format_stale_preview'
    assert again['step']['count'] == 5
    assert set((await _groups(driver)).values()) == {'legacy:personal:legacy-space'}


async def _seed_duplicate_buckets(driver, copies):
    await _seed_legacy_principal(driver)
    await driver.execute_query(
        """
        UNWIND range(1, $copies) AS copy
        CREATE (:FuliProjectAgentExecutorOutcomeAggregate {
          id: 'legacy-aggregate-' + copy, aggregate_id: 'legacy-aggregate-' + copy,
          personal_space_id: 'legacy-space', personal_project_id: 'project', work_kind: 'implementation',
          agent_id: 'agent', executor_id: 'executor', model_strategy_key: 'strategy',
          as_of: datetime('2026-01-01T00:00:00Z') + duration({days: copy})})
        WITH count(*) AS created
        MERGE (f:FuliDataFormat {store: 'graph'}) SET f.version = 1
        """,
        copies=copies,
    )


@pytest.mark.asyncio
async def test_a_step_that_deletes_says_so_first_binds_each_deletion_and_cannot_be_undone(graph):
    settings, driver = graph
    await _seed_duplicate_buckets(driver, 2)

    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
        assert plan['step']['id'] == 'graph/2-learning-bucket-ids' and plan['undo'] == 'restore_only'
        assert plan['step']['count'] == 2
        assert sorted(key.split(':')[0] for key in plan['step']['sampleIds']) == ['delete', 'keep']
        assert 'cannot restore deleted records' in plan['warning']
        assert '(1 records deleted)' in plan['warning'] and 'fuli graph import' in plan['warning']
        # One more duplicate of the same bucket: one more deletion, a different plan.
        await driver.execute_query(
            """
            CREATE (:FuliProjectAgentExecutorOutcomeAggregate {
              id: 'legacy-aggregate-3', aggregate_id: 'legacy-aggregate-3',
              personal_space_id: 'legacy-space', personal_project_id: 'project',
              work_kind: 'implementation', agent_id: 'agent', executor_id: 'executor',
              model_strategy_key: 'strategy', as_of: datetime('2025-12-01T00:00:00Z')})
            """
        )
        stale = await client.post('/v1/data-format/apply', headers=REVIEW,
                                  json={'digest': plan['digest'], 'entrypoint': 'cli'})
        assert stale.status_code == 409
        fresh = (await client.post('/v1/data-format/preview')).json()['plan']
        assert fresh['step']['count'] == 3
        applied = await client.post('/v1/data-format/apply', headers=REVIEW,
                                    json={'digest': fresh['digest'], 'entrypoint': 'cli'})
        assert applied.status_code == 200, applied.text
        undo = await client.post('/v1/data-format/rollback', headers=REVIEW,
                                 json={'migration_id': 'graph/2-learning-bucket-ids', 'entrypoint': 'cli'})

    assert undo.status_code == 409 and undo.json()['detail']['code'] == 'data_format_undo_blocked'
    aggregates = await _rows(driver, 'MATCH (a:FuliProjectAgentExecutorOutcomeAggregate) RETURN count(a) AS n')
    assert aggregates == [{'n': 1}]


async def _seed_unreleased_public_project(driver):
    await _seed_legacy_principal(driver)
    await driver.execute_query(
        """
        MATCH (p:FuliPrincipal {id: 'legacy-principal'})
        CREATE (p)-[:OWNS]->(:FuliSpace {id: 'public-project', kind: 'project', visibility: 'public',
                                        name: 'Synthetic public project', group_id: 'public-project',
                                        created_at: datetime('2026-01-02T00:00:00Z')})
        MERGE (f:FuliDataFormat {store: 'graph'}) SET f.version = 7
        """
    )


@pytest.mark.asyncio
async def test_only_what_the_apply_created_is_journaled_and_undone(graph):
    settings, driver = graph
    await _seed_unreleased_public_project(driver)
    managed, maintenance = _maintenance(settings)
    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        plan = (await client.post('/v1/data-format/preview')).json()['plan']

    async def another_process_creates_a_release():
        await driver.execute_query(
            "CREATE (:FuliProjectRelease {id: 'release-from-another-provider', version: '1.0'})"
        )

    try:
        result = await graph_format_confirm.apply_graph_migration(
            maintenance, settings, digest=plan['digest'], actor={'entrypoint': 'cli'},
            barrier=another_process_creates_a_release,
        )
        created = await _rows(driver, """
            MATCH (u:FuliDataFormatUndo {apply_id: $apply_id, kind: 'created'}) RETURN u.target AS target
        """, apply_id=result['applyId'])
        assert sorted(row['target'] for row in created) == ['node', 'relationship']
        tagged = await _rows(driver, 'MATCH (n) WHERE n.fuli_format_apply_id IS NOT NULL RETURN count(n) AS n')
        assert tagged == [{'n': 0}]

        await graph_format_confirm.rollback_graph_migration(
            maintenance, settings, migration_id=RELEASE_STEP, actor={'entrypoint': 'cli'})
    finally:
        await managed.close()

    assert await _rows(driver, 'MATCH (r:FuliProjectRelease) RETURN r.id AS id') == [
        {'id': 'release-from-another-provider'}]


@pytest.mark.asyncio
async def test_a_business_write_during_an_undo_waits_and_lands_after_it(graph):
    settings, driver = graph
    await _seed_colon_groups(driver)
    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
        await client.post('/v1/data-format/apply', headers=REVIEW,
                          json={'digest': plan['digest'], 'entrypoint': 'cli'})
    business = {}

    async def a_business_write_arrives():
        business['task'] = asyncio.create_task(driver.execute_query(
            "MATCH (e:Entity {uuid: 'entity-b'}) SET e.name = 'renamed by a person meanwhile'"
        ))
        await asyncio.sleep(1.5)
        business['blocked'] = not business['task'].done()

    managed, maintenance = _maintenance(settings)
    try:
        await graph_format_confirm.rollback_graph_migration(
            maintenance, settings, migration_id=GROUP_STEP, actor={'entrypoint': 'cli'},
            barrier=a_business_write_arrives,
        )
    finally:
        await managed.close()
    await business['task']

    assert business['blocked'], 'the write waited for the undo to commit'
    rows = await _rows(driver, "MATCH (e:Entity {uuid: 'entity-b'}) RETURN e.name AS name, e.group_id AS g")
    assert rows == [{'name': 'renamed by a person meanwhile', 'g': 'legacy:personal:legacy-space'}]


@pytest.mark.asyncio
async def test_an_undo_is_refused_once_a_newer_fuli_moved_the_graph_on(graph):
    settings, driver = graph
    await _seed_colon_groups(driver)
    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
        await client.post('/v1/data-format/apply', headers=REVIEW,
                          json={'digest': plan['digest'], 'entrypoint': 'cli'})
    await driver.execute_query(
        "MATCH (f:FuliDataFormat {store: 'graph'}) SET f.version = $version",
        version=GRAPH_FORMAT_VERSION + 1,
    )
    before = await _groups(driver)
    managed, maintenance = _maintenance(settings)
    try:
        with pytest.raises(GraphFormatUnavailable) as refused:
            await graph_format_confirm.rollback_graph_migration(
                maintenance, settings, migration_id=GROUP_STEP, actor={'entrypoint': 'cli'})
    finally:
        await managed.close()

    assert refused.value.code == 'data_format_blocked'
    assert await _groups(driver) == before
    assert await _version(driver) == GRAPH_FORMAT_VERSION + 1


# What FULI 11 stored for Bole and the built-in hr occupation in a space.
BUILTIN_OCCUPATION_SEED = """
    MATCH (space:FuliSpace {id: 'legacy-space'})
    CREATE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(:FuliProjectAgent {id: 'legacy-bole',
             agent_id: 'employee.bole', name: 'Bole', status: 'active', occupation_role: 'management',
             occupation_tags: [], occupation_updated_at: datetime('2026-10-01T00:00:00Z'),
             created_at: datetime('2026-10-01T00:00:00Z')})
    CREATE (space)-[:HAS_OCCUPATION]->(:FuliOccupation {id: 'legacy-hr', key: 'hr', builtin: true,
             status: 'active', name_zh: '人力资源', name_en: 'Human resources',
             description_zh: '维护人员职责、招募安排和协作记录。',
             description_en: 'Maintain role responsibilities, recruitment arrangements, and staffing records.',
             revision: 0, created_at: datetime('2026-10-01T00:00:00Z'),
             updated_at: datetime('2026-10-01T00:00:00Z')})
"""


# graph/4–7 and 12 once each: a synthetic graph an earlier FULI left one step short,
# apply it through the review channel, then undo it. Each case: the version
# before the step, what to seed, and a read that differs after the step.
RECORD_STEPS = {
    'graph/4-legacy-agent-assignments': (3, """
        MATCH (space:FuliSpace {id: 'legacy-space'})
        CREATE (space)-[:CONTAINS_PROJECT]->(p:FuliPersonalProject {id: 'legacy-project',
                 project_id: 'legacy-project'})-[:HAS_PROJECT_AGENT]->(:FuliProjectAgent {
                 id: 'legacy-agent', name: 'Synthetic legacy agent',
                 created_at: datetime('2026-01-03T00:00:00Z')})
    """, """
        MATCH (a:FuliProjectAgent {id: 'legacy-agent'})
        OPTIONAL MATCH (a)<-[:ASSIGNED_AGENT]-(assignment:FuliProjectAgentAssignment)
        OPTIONAL MATCH (a)<-[identity:HAS_PROJECT_AGENT_IDENTITY]-(:FuliSpace)
        RETURN a.agent_id AS agent_id, a.status AS status, count(DISTINCT assignment) AS assignments,
               count(DISTINCT identity) AS identities
    """),
    'graph/5-knowledge-lifecycle-defaults': (4, """
        CREATE (a:Entity {uuid: 'legacy-entity-a', name: 'Synthetic entity', group_id: 'legacy-group'})
        CREATE (b:Entity {uuid: 'legacy-entity-b', name: 'Synthetic other', group_id: 'legacy-group'})
        CREATE (a)-[:RELATES_TO {uuid: 'legacy-fact', fact: 'Synthetic fact', group_id: 'legacy-group'}]->(b)
    """, """
        MATCH (e:Entity {uuid: 'legacy-entity-a'})-[r:RELATES_TO]->()
        RETURN e.fuli_utility_score AS entity_score, e.fuli_inheritance_mode AS mode,
               r.fuli_confidence_score AS fact_confidence, e.fuli_ai_review_lock_version AS lock
    """),
    'graph/6-project-relation-review-defaults': (5, """
        MATCH (space:FuliSpace {id: 'legacy-space'})
        CREATE (space)-[:CONTAINS_PROJECT]->(a:FuliPersonalProject {id: 'project-a', project_id: 'project-a'})
        CREATE (space)-[:CONTAINS_PROJECT]->(b:FuliPersonalProject {id: 'project-b', project_id: 'project-b'})
        CREATE (a)-[:PERSONAL_PROJECT_RELATION {id: 'legacy-relation'}]->(b)
    """, """
        MATCH ()-[r:PERSONAL_PROJECT_RELATION {id: 'legacy-relation'}]->()
        RETURN r.status AS status, r.decision_revision AS revision
    """),
    'graph/12-builtin-occupations': (11, BUILTIN_OCCUPATION_SEED, """
        MATCH (bole:FuliProjectAgent {id: 'legacy-bole'}), (hr:FuliOccupation {id: 'legacy-hr'})
        RETURN bole.occupation_role AS role, bole.occupation_updated_at AS role_since,
               hr.name_zh AS name, hr.description_en AS duties, hr.revision AS revision
    """),
    'graph/7-space-visibility-owners': (6, """
        MATCH (p:FuliPrincipal {id: 'legacy-principal'})
        CREATE (p)-[:MEMBER_OF {role: 'maintainer', created_at: datetime('2026-01-04T00:00:00Z')}]->
               (:FuliSpace {id: 'legacy-project-space', kind: 'project', name: 'Synthetic project space',
                            group_id: 'legacy-project-space'})
    """, """
        MATCH (s:FuliSpace {id: 'legacy-project-space'})
        OPTIONAL MATCH (owner:FuliPrincipal)-[:OWNS]->(s)
        RETURN s.visibility AS visibility, count(owner) AS owners
    """),
}


@pytest.mark.asyncio
@pytest.mark.parametrize('step_id', sorted(RECORD_STEPS))
async def test_each_record_step_applies_and_undoes_on_a_synthetic_graph(graph, step_id):
    settings, driver = graph
    version, seed, read = RECORD_STEPS[step_id]
    await _seed_legacy_principal(driver)
    await driver.execute_query(seed)
    await driver.execute_query(
        "MERGE (f:FuliDataFormat {store: 'graph'}) SET f.version = $version", version=version
    )
    before = await _rows(driver, read)

    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        health = (await client.get('/health')).json()['data_format']
        assert health['pending'] == [step_id], health
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
        assert plan['step']['id'] == step_id and plan['step']['count'] >= 1 and plan['undo'] == 'available'
        applied = await client.post('/v1/data-format/apply', headers=REVIEW,
                                    json={'digest': plan['digest'], 'entrypoint': 'cli'})
        assert applied.status_code == 200, applied.text
        after = await _rows(driver, read)
        assert after != before, 'the step changed the seeded records'
        undone = await client.post('/v1/data-format/rollback', headers=REVIEW,
                                   json={'migration_id': step_id, 'entrypoint': 'cli'})
        assert undone.status_code == 200, undone.text

    assert await _rows(driver, read) == before
    assert await _version(driver) == version


@pytest.mark.asyncio
async def test_builtin_occupations_change_only_what_fuli_shipped(graph):
    """Bole and hr move to Agent resources; a person's own role or text stays."""
    settings, driver = graph
    await _seed_legacy_principal(driver)
    await driver.execute_query(BUILTIN_OCCUPATION_SEED)
    # A second space where the person had changed Bole's role and hr's Chinese name.
    await driver.execute_query('''
        MATCH (p:FuliPrincipal {id: 'legacy-principal'})
        CREATE (p)-[:OWNS]->(space:FuliSpace {id: 'edited-space', kind: 'personal', name: 'Synthetic edited space',
                                              visibility: 'private', group_id: 'edited-space',
                                              created_at: datetime('2026-01-01T00:00:00Z')})
        CREATE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(:FuliProjectAgent {id: 'edited-bole',
                 agent_id: 'employee.bole', name: 'Bole', status: 'active', occupation_role: 'research',
                 occupation_tags: [], occupation_updated_at: datetime('2026-10-02T00:00:00Z'),
                 created_at: datetime('2026-10-01T00:00:00Z')})
        WITH space
        MATCH (shipped:FuliOccupation {id: 'legacy-hr'})
        CREATE (space)-[:HAS_OCCUPATION]->(edited:FuliOccupation)
        SET edited = properties(shipped), edited.id = 'edited-hr', edited.name_zh = '人事', edited.revision = 3
    ''')
    await driver.execute_query("MERGE (f:FuliDataFormat {store: 'graph'}) SET f.version = 11")

    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
        assert plan['step']['id'] == 'graph/12-builtin-occupations'
        # Only the shipped Bole and both hr rows (each still holds some shipped text).
        assert plan['step']['count'] == 3, plan
        applied = await client.post('/v1/data-format/apply', headers=REVIEW,
                                    json={'digest': plan['digest'], 'entrypoint': 'cli'})
        assert applied.status_code == 200, applied.text

    agents = {row['id']: row for row in await _rows(driver, '''
        MATCH (a:FuliProjectAgent) RETURN a.id AS id, a.occupation_role AS role,
               toString(a.occupation_updated_at) AS since''')}
    assert agents['legacy-bole']['role'] == 'hr'
    assert agents['legacy-bole']['since'] != '2026-10-01T00:00:00Z'
    assert agents['edited-bole'] == {'id': 'edited-bole', 'role': 'research', 'since': '2026-10-02T00:00:00Z'}
    hr = {row['id']: row for row in await _rows(driver, '''
        MATCH (o:FuliOccupation) RETURN o.id AS id, o.name_zh AS name_zh, o.name_en AS name_en,
               o.description_zh AS description_zh, o.revision AS revision''')}
    assert hr['legacy-hr'] == {'id': 'legacy-hr', 'name_zh': 'Agent 资源', 'name_en': 'Agent resources',
                               'description_zh': '维护 Agent 的职责、招募安排和人员配置记录。', 'revision': 1}
    assert hr['edited-hr'] == {'id': 'edited-hr', 'name_zh': '人事', 'name_en': 'Agent resources',
                               'description_zh': '维护 Agent 的职责、招募安排和人员配置记录。', 'revision': 4}
    assert await _version(driver) == GRAPH_FORMAT_VERSION


def _provider_b(settings):
    """Another running provider that decided "writable" before the migration."""
    driver = ManagedNeo4jDriver(uri=settings.neo4j_uri, user=settings.neo4j_user,
                                password=settings.neo4j_password, database=settings.neo4j_database)
    driver.format = GraphFormatState('write', 'current', GRAPH_FORMAT_VERSION)
    return driver


@pytest.mark.asyncio
async def test_another_provider_cannot_write_between_the_snapshot_and_the_step(graph):
    settings, driver = graph
    await _seed_colon_groups(driver)
    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
    provider_b = _provider_b(settings)
    managed, maintenance = _maintenance(settings)
    write = {}

    async def provider_b_writes_after_the_snapshot():
        write['task'] = asyncio.create_task(provider_b.execute_query(
            "MATCH (e:Entity {uuid: 'entity-a'}) SET e.fuli_confidence_score = 0.9"
        ))
        await asyncio.sleep(1.5)
        write['waited'] = not write['task'].done()

    try:
        await graph_format_confirm.apply_graph_migration(
            maintenance, settings, digest=plan['digest'], actor={'entrypoint': 'cli'},
            barrier=provider_b_writes_after_the_snapshot,
        )
        with pytest.raises(GraphFormatUnavailable) as refused:
            await write['task']
    finally:
        await provider_b.close()
        await managed.close()

    assert write['waited'], 'the write waited for the migration to commit'
    assert refused.value.code == 'data_format_changed_underneath'
    rows = await _rows(driver, "MATCH (e:Entity {uuid: 'entity-a'}) RETURN e.fuli_confidence_score AS score")
    assert rows == [{'score': 0.5}], 'nothing provider B meant to write was written'


@pytest.mark.asyncio
async def test_a_record_added_between_the_snapshot_and_the_step_rolls_the_apply_back(graph):
    settings, driver = graph
    await _seed_colon_groups(driver)
    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
    before = await _groups(driver)
    managed, maintenance = _maintenance(settings)

    async def a_writer_outside_fuli_files_one_more():
        # Not through any provider, so no writer fence stops it.
        await driver.execute_query(
            "CREATE (:Entity {uuid: 'entity-late', group_id: 'legacy:personal:legacy-space'})"
        )

    try:
        with pytest.raises(GraphFormatUnavailable) as refused:
            await graph_format_confirm.apply_graph_migration(
                maintenance, settings, digest=plan['digest'], actor={'entrypoint': 'cli'},
                barrier=a_writer_outside_fuli_files_one_more,
            )
    finally:
        await managed.close()

    assert refused.value.code == 'data_format_stale_preview'
    groups = await _groups(driver)
    assert {key: groups[key] for key in before} == before
    assert groups['node:entity-late'] == 'legacy:personal:legacy-space'
    assert await _rows(driver, 'MATCH (u:FuliDataFormatUndo) RETURN count(u) AS n') == [{'n': 0}]


@pytest.mark.asyncio
async def test_another_provider_cannot_write_during_an_undo_and_learns_the_graph_moved(graph):
    settings, driver = graph
    await _seed_colon_groups(driver)
    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
        await client.post('/v1/data-format/apply', headers=REVIEW,
                          json={'digest': plan['digest'], 'entrypoint': 'cli'})
    provider_b = _provider_b(settings)
    managed, maintenance = _maintenance(settings)
    write = {}

    async def provider_b_writes_during_the_undo():
        write['task'] = asyncio.create_task(provider_b.execute_query(
            "MATCH (e:Entity {uuid: 'entity-b'}) SET e.name = 'written by provider B'"
        ))
        await asyncio.sleep(1.5)
        write['waited'] = not write['task'].done()

    try:
        await graph_format_confirm.rollback_graph_migration(
            maintenance, settings, migration_id=GROUP_STEP, actor={'entrypoint': 'cli'},
            barrier=provider_b_writes_during_the_undo,
        )
        with pytest.raises(GraphFormatUnavailable) as refused:
            await write['task']
    finally:
        await provider_b.close()
        await managed.close()

    assert write['waited'] and refused.value.code == 'data_format_changed_underneath'
    rows = await _rows(driver, "MATCH (e:Entity {uuid: 'entity-b'}) RETURN e.name AS name, e.group_id AS g")
    assert rows == [{'name': 'Synthetic other entity', 'g': 'legacy:personal:legacy-space'}]


async def _seed_journals(driver):
    """Five synthetic undo journals, newest first: applied, applied, undone, applied, undone,
    in a graph whose ledger is at the current version."""
    await driver.execute_query(
        "MERGE (f:FuliDataFormat {store: 'graph'}) SET f.version = $version", version=GRAPH_FORMAT_VERSION,
    )
    await driver.execute_query(
        """
        UNWIND $journals AS journal
        CREATE (:FuliDataFormatUndo {apply_id: journal.id, kind: 'apply', migration_id: 'graph/5-x',
                                     state: journal.state, reversible: true, plan_digest: journal.id,
                                     from_version: 4, to_version: 5,
                                     recorded_at: datetime(journal.at)})
        WITH journal
        UNWIND range(1, 2) AS entry
        CREATE (:FuliDataFormatUndo {apply_id: journal.id, kind: 'record', touch: 0, target: 'node',
                                     ref: journal.id + ':' + entry, after_hash: 'h'})
        """,
        journals=[
            {'id': 'j1', 'state': 'applied', 'at': '2026-10-05T00:00:00Z'},
            {'id': 'j2', 'state': 'applied', 'at': '2026-10-04T00:00:00Z'},
            {'id': 'j3', 'state': 'rolled_back', 'at': '2026-10-03T00:00:00Z'},
            {'id': 'j4', 'state': 'applied', 'at': '2026-10-02T00:00:00Z'},
            {'id': 'j5', 'state': 'rolled_back', 'at': '2026-10-01T00:00:00Z'},
        ],
    )


async def _journal_ids(driver):
    rows = await _rows(driver, "MATCH (u:FuliDataFormatUndo {kind: 'apply'}) RETURN u.apply_id AS id ORDER BY id")
    return [row['id'] for row in rows]


@pytest.mark.asyncio
async def test_undo_journals_are_pruned_to_the_soft_target_undone_ones_first(graph):
    settings, driver = graph
    await _seed_legacy_principal(driver)
    await _seed_journals(driver)
    managed, maintenance = _maintenance(settings)
    try:
        dry = await graph_format_confirm.prune_graph_journals(maintenance, settings, keep=2, dry_run=True)
        assert await _journal_ids(driver) == ['j1', 'j2', 'j3', 'j4', 'j5']
        result = await graph_format_confirm.prune_graph_journals(maintenance, settings, keep=2)
    finally:
        await managed.close()

    assert [entry['applyId'] for entry in result['pruned']] == [entry['applyId'] for entry in dry['pruned']]
    assert sorted(entry['applyId'] for entry in result['pruned']) == ['j3', 'j5'], 'undone journals go first'
    assert await _journal_ids(driver) == ['j1', 'j2', 'j4']
    assert await _rows(driver, "MATCH (u:FuliDataFormatUndo {apply_id: 'j3'}) RETURN count(u) AS n") == [{'n': 0}]
    assert all(set(entry) == {'store', 'applyId', 'migrationId', 'state', 'bytes', 'reason'} for entry in result['pruned'])


@pytest.mark.asyncio
async def test_the_journal_an_undo_needs_is_never_pruned(graph):
    settings, driver = graph
    await _seed_legacy_principal(driver)
    await _seed_journals(driver)
    managed, maintenance = _maintenance(settings)
    try:
        result = await graph_format_confirm.prune_graph_journals(maintenance, settings, keep=0,
                                                                  apply_ids=['j1', 'j2', 'j3', 'j4', 'j5'])
    finally:
        await managed.close()

    assert result['protected'] == 'j1'
    assert await _journal_ids(driver) == ['j1']
    assert await _rows(driver, "MATCH (u:FuliDataFormatUndo {apply_id: 'j1'}) RETURN count(u) AS n") == [{'n': 3}]


@pytest.mark.asyncio
async def test_the_shared_size_budget_prunes_the_journals_it_chose_and_a_dry_run_lists_what_stays(graph):
    settings, driver = graph
    await _seed_legacy_principal(driver)
    await _seed_journals(driver)
    managed, maintenance = _maintenance(settings)
    try:
        plan = await graph_format_confirm.prune_graph_journals(maintenance, settings, keep=3, dry_run=True)
        result = await graph_format_confirm.prune_graph_journals(maintenance, settings, keep=3,
                                                                  apply_ids=['j2', 'j-gone'])
    finally:
        await managed.close()

    # keep=3: the protected j1 and three others stay, j5 (the older undone one) goes.
    assert [entry['applyId'] for entry in plan['pruned']] == ['j5']
    assert [(j['applyId'], j['protected']) for j in plan['journals']] == [
        ('j1', True), ('j2', False), ('j3', False), ('j4', False)]
    assert all(j['bytes'] > 0 and j['recordedAt'] for j in plan['journals'])
    assert {entry['applyId']: entry['reason'] for entry in result['pruned']} == {
        'j5': 'more than 3 undo journals', 'j2': 'over the shared size budget'}
    assert await _journal_ids(driver) == ['j1', 'j3', 'j4']


@pytest.mark.asyncio
async def test_pruning_journals_takes_the_review_channel(graph):
    settings, driver = graph
    await _seed_colon_groups(driver)
    await _seed_journals(driver)
    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        body = {'keep': 0}
        refused = await client.post('/v1/data-format/prune', json=body)
        pruned = await client.post('/v1/data-format/prune', headers=REVIEW, json=body)

    assert refused.status_code == 403
    assert pruned.status_code == 200, pruned.text
    assert await _journal_ids(driver) == ['j1']


async def _seed_older_applied_journal(driver, apply_id='b-older'):
    """B: an applied journal older than the one a real apply just wrote (A)."""
    await driver.execute_query(
        """
        CREATE (:FuliDataFormatUndo {apply_id: $id, kind: 'apply', migration_id: 'graph/5-x',
                                     state: 'applied', reversible: true, plan_digest: $id,
                                     from_version: 4, to_version: 5,
                                     recorded_at: datetime('2026-10-01T00:00:00Z')})
        CREATE (:FuliDataFormatUndo {apply_id: $id, kind: 'record', touch: 0, target: 'node',
                                     ref: $id + ':1', after_hash: 'h'})
        """,
        id=apply_id,
    )


async def _apply_group_step(settings):
    async with provider_client(_reviewed(settings), ACCESS_TOKEN) as (client, _):
        plan = (await client.post('/v1/data-format/preview')).json()['plan']
        applied = await client.post('/v1/data-format/apply', headers=REVIEW,
                                    json={'digest': plan['digest'], 'entrypoint': 'cli'})
    assert applied.status_code == 200, applied.text
    return applied.json()['applyId']


def _an_hour_ago():
    # A lease taken with this clock has already expired when it is taken.
    from datetime import datetime, timedelta, timezone
    return datetime.now(timezone.utc) - timedelta(hours=1)


async def _journal_states(driver):
    rows = await _rows(driver, """
        MATCH (u:FuliDataFormatUndo) WITH u.apply_id AS id, count(u) AS entries,
              max(CASE WHEN u.kind = 'apply' THEN u.state END) AS state
        RETURN id, state, entries ORDER BY id""")
    return [dict(row) for row in rows]


@pytest.mark.asyncio
async def test_a_prune_whose_lease_expired_while_another_process_undid_a_step_deletes_nothing(graph):
    settings, driver = graph
    await _seed_colon_groups(driver)
    newest = await _apply_group_step(settings)
    await _seed_older_applied_journal(driver)
    managed, maintenance = _maintenance(settings)
    other, other_maintenance = _maintenance(settings)

    async def the_lease_expires_and_another_process_undoes_a(stage):
        if stage != 'lease_held':
            return
        # The old prune's lease has run out; another process takes it over and
        # undoes A, so B is now the journal the next undo needs.
        await graph_format_confirm.rollback_graph_migration(
            other_maintenance, settings, migration_id=GROUP_STEP, actor={'entrypoint': 'cli'})

    try:
        with pytest.raises(GraphFormatUnavailable) as refused:
            await graph_format_confirm.prune_graph_journals(
                maintenance, settings, keep=0, now=_an_hour_ago,
                barrier=the_lease_expires_and_another_process_undoes_a)
    finally:
        await managed.close()
        await other.close()

    assert refused.value.code == 'data_format_locked'
    states = {row['id']: row['state'] for row in await _journal_states(driver)}
    assert states == {newest: 'rolled_back', 'b-older': 'applied'}, 'B survives for the next undo'


@pytest.mark.asyncio
async def test_an_undo_that_arrives_while_a_prune_holds_the_ledger_waits_for_its_commit(graph):
    settings, driver = graph
    await _seed_colon_groups(driver)
    newest = await _apply_group_step(settings)
    await _seed_older_applied_journal(driver)
    managed, maintenance = _maintenance(settings)
    other, other_maintenance = _maintenance(settings)
    undo = {}

    async def an_undo_arrives_after_the_journals_were_read(stage):
        if stage != 'journals_read':
            return
        # Even though the prune's lease has expired, the undo cannot take it over.
        undo['task'] = asyncio.create_task(graph_format_confirm.rollback_graph_migration(
            other_maintenance, settings, migration_id=GROUP_STEP, actor={'entrypoint': 'cli'}))
        await asyncio.sleep(1.5)
        undo['waited'] = not undo['task'].done()

    try:
        result = await graph_format_confirm.prune_graph_journals(
            maintenance, settings, keep=0, now=_an_hour_ago,
            barrier=an_undo_arrives_after_the_journals_were_read)
        undone = await undo['task']
    finally:
        await managed.close()
        await other.close()

    # The two ran one after the other: the prune saw A as the journal an undo
    # needed and kept it, then the undo used it.
    assert undo['waited'], 'the undo waited for the prune to commit'
    assert result['protected'] == newest and [entry['applyId'] for entry in result['pruned']] == ['b-older']
    assert undone['applyId'] == newest
    assert [(row['id'], row['state']) for row in await _journal_states(driver)] == [(newest, 'rolled_back')]


@pytest.mark.asyncio
async def test_a_graph_a_newer_fuli_wrote_keeps_every_undo_journal(graph):
    settings, driver = graph
    await _seed_legacy_principal(driver)
    await _seed_journals(driver)
    await driver.execute_query(
        "MATCH (f:FuliDataFormat {store: 'graph'}) SET f.version = $version",
        version=GRAPH_FORMAT_VERSION + 1,
    )
    before = await _journal_states(driver)
    managed, maintenance = _maintenance(settings)
    try:
        for dry_run in (True, False):
            with pytest.raises(GraphFormatUnavailable) as refused:
                await graph_format_confirm.prune_graph_journals(
                    maintenance, settings, keep=0, dry_run=dry_run)
            assert refused.value.code == 'data_format_blocked'
    finally:
        await managed.close()

    assert len(before) == 5 and await _journal_states(driver) == before
    assert await _version(driver) == GRAPH_FORMAT_VERSION + 1


@pytest.mark.asyncio
async def test_journal_sizes_count_utf8_bytes_not_characters(graph):
    settings, driver = graph
    # Two journals alike but for one record's text: two Latin letters, or two
    # Chinese characters of three UTF-8 bytes each.
    for apply_id, ref in (('ja', 'ab'), ('jb', '记录')):
        await driver.execute_query(
            """
            CREATE (:FuliDataFormatUndo {apply_id: $id, kind: 'apply', migration_id: 'graph/5-x',
                                         state: 'rolled_back', recorded_at: datetime('2026-10-01T00:00:00Z')})
            CREATE (:FuliDataFormatUndo {apply_id: $id, kind: 'record', ref: $ref})
            """,
            id=apply_id, ref=ref,
        )
    sizes = {j['applyId']: j['bytes'] for j in await journal_inventory(driver)}

    assert sizes['jb'] - sizes['ja'] == 4
