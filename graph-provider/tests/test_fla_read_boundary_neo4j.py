"""The FLA read boundary (0.20.1) against an explicitly disposable Neo4j.

Knowledge an FLA's own episodes wrote, and a preference given to one FLA, are
read only by that FLA in its project and by the person's console (the
human-review proof). Another FLA, a plain session and the AI review see none
of it: not in the graph, an item view, its evidence or versions, a receipt or
a session's records. Synthetic data only; public HTTP routes drive every
write, except two direct links no route writes (noted where they are made)."""

from uuid import uuid4

import pytest
from neo4j import AsyncGraphDatabase

from test_project_agent_memory_neo4j import provider_client, seed_agent
from test_session_records_neo4j import Session
from test_turn_receipt_neo4j import REVIEW, ok, reviewed_settings

PROJECT = 'sample-project'
G, H = 'engineer', 'reviewer'
AS_G = {'reader_project_id': PROJECT, 'reader_agent_id': G}
AS_H = {'reader_project_id': PROJECT, 'reader_agent_id': H}
WRONG_PROOF = {'x-fuli-human-review-token': 'synthetic-wrong-review-token-0123456789'}


def entity(key, text, **fields):
    return {'key': key, 'name': text, 'type': 'ProjectFact', 'summary': text, 'origin_quadrant': 'known_known',
            **fields}


async def commit(client, space_id, entities, *, agent=None, relationships=(), session_id='synthetic-boundary'):
    return ok(await client.post('/v1/knowledge/commits', json={
        'space_id': space_id, 'personal_project_id': PROJECT, 'project_agent_id': agent,
        'episode': {'idempotency_key': f'boundary-{uuid4()}', 'session_id': session_id,
                    'name': 'Synthetic boundary turn', 'source_kind': 'task_remember',
                    'source_description': 'Synthetic items for the FLA read boundary.',
                    'source_application': 'codex', 'source_excerpt': entities[0]['summary'],
                    'reference_time': '2026-10-24T00:00:00Z', 'entities': entities,
                    'relationships': list(relationships)}}))


class Boundary:
    """One space: FLA G's own facts, preference and edge; a plain fact; a
    plain edge to G's fact; an older FLA version a plain item replaced; and
    a project preference with G's words as evidence."""

    async def build(self, client, settings):
        self.client = client
        self.space_id = ok(await client.post('/v1/spaces', json={'name': f'Synthetic boundary {uuid4()}',
                                                                  'kind': 'personal'}))['id']
        await seed_agent(client, self.space_id, PROJECT, G)
        await seed_agent(client, self.space_id, PROJECT, H)
        self.fla = await commit(client, self.space_id, [
            entity('fla-fact', 'G deploys through the canary lane'),
            entity('fla-target', 'Canary lane'),
            entity('fla-old', 'G once deployed by hand'),
            {**entity('fla-habit', 'G reviews diffs before tests'), 'type': 'PersonalPreference',
             'profile_aspect': 'taste'}], agent=G,
            relationships=[{'key': 'fla-edge', 'source': 'fla-fact', 'target': 'fla-target', 'type': 'USES',
                            'fact': 'G deploys through the canary lane'}])
        self.plain = await commit(client, self.space_id, [
            entity('plain-fact', 'Releases are tagged on main'),
            entity('plain-new', 'Deploys run from the pipeline'),
            {**entity('shared-habit', 'Lead with the conclusion'), 'type': 'PersonalPreference',
             'profile_aspect': 'taste'}])
        graph = await self.graph(headers=REVIEW)
        self.ids = {node['name']: node['id'] for node in graph['nodes'] if node.get('summary')}
        self.group_id = next(node['group_id'] for node in graph['nodes'] if node['id'] == self.id('plain-fact'))
        self.fla_edge = next(edge['id'] for edge in graph['edges'] if edge['fact'] == 'G deploys through the canary lane')
        self.plain_edge = f'boundary-plain-edge-{uuid4()}'
        # No route writes these two links today; they stand for older or
        # imported data the boundary still has to hold.
        driver = AsyncGraphDatabase.driver(settings.neo4j_uri, auth=('neo4j', settings.neo4j_password))
        try:
            await driver.execute_query('''
                MATCH (plain:Entity {uuid: $plain}), (fla:Entity {uuid: $fla}),
                      (old:Entity {uuid: $old}), (new:Entity {uuid: $new}), (habit:Entity {uuid: $habit})
                CREATE (link:Episodic {uuid: $link_episode, group_id: $group_id, created_at: datetime(),
                        fuli_personal_project_id: $project})
                CREATE (link)-[:MENTIONS {uuid: $link_episode + '-mention', group_id: $group_id}]->(plain)
                CREATE (plain)-[:RELATES_TO {uuid: $edge, group_id: $group_id, name: 'LINKS',
                        fact: 'Releases link to the canary lane', episodes: [$link_episode],
                        created_at: datetime()}]->(fla)
                SET old.fuli_replaced_by_item_id = new.uuid, old.fuli_replaced_by_item_kind = 'entity',
                    old.fuli_invalid_at = datetime()
                CREATE (words:Episodic {uuid: $words_episode, group_id: $group_id, created_at: datetime(),
                        fuli_project_agent_id: $agent, fuli_personal_project_id: $project,
                        fuli_source_excerpt: 'G words about leading with the conclusion'})
                CREATE (words)-[:MENTIONS {uuid: $words_episode + '-mention', group_id: $group_id}]->(habit)
            ''', plain=self.id('plain-fact'), fla=self.id('fla-fact'), old=self.id('fla-old'),
                new=self.id('plain-new'), habit=self.id('shared-habit'), group_id=self.group_id, edge=self.plain_edge,
                link_episode=f'boundary-link-{uuid4()}', words_episode=f'boundary-words-{uuid4()}',
                agent=G, project=PROJECT)
        finally:
            await driver.close()
        return self

    def id(self, key):
        return {
            'fla-fact': self.ids['G deploys through the canary lane'], 'fla-target': self.ids['Canary lane'],
            'fla-old': self.ids['G once deployed by hand'], 'fla-habit': self.ids['G reviews diffs before tests'],
            'plain-fact': self.ids['Releases are tagged on main'], 'plain-new': self.ids['Deploys run from the pipeline'],
            'shared-habit': self.ids['Lead with the conclusion'],
        }[key]

    def fla_ids(self):
        return {self.id(key) for key in ('fla-fact', 'fla-target', 'fla-old', 'fla-habit')}

    async def graph(self, params=None, headers=None):
        return ok(await self.client.get(f'/v1/spaces/{self.space_id}/graph', headers=headers,
                                        params={'personal_project_id': PROJECT, 'limit': 500, **(params or {})}))

    async def view(self, key, reader=None, headers=None):
        return await self.client.post('/v1/knowledge/item-views', headers=headers, json={
            'personal_space_id': self.space_id, 'item_kind': 'entity', 'item_id': self.id(key), **(reader or {})})

    async def receipt(self, episode_id, reader=None, headers=None):
        return ok(await self.client.post('/v1/knowledge/turn-receipts', headers=headers, json={
            'personal_space_id': self.space_id, 'episode_ids': [episode_id], **(reader or {})}))


def knowledge(graph):
    return {node['id'] for node in graph['nodes']}, {edge['id'] for edge in graph['edges']}


@pytest.mark.asyncio
async def test_the_graph_shows_an_flas_own_knowledge_to_it_and_the_person_only():
    settings = reviewed_settings()
    async with provider_client(settings) as (client, _):
        space = await Boundary().build(client, settings)
        visible_to_all = {space.id('plain-fact'), space.id('plain-new'), space.id('shared-habit')}
        for params in ({}, {'offset': 0}):
            owner_nodes, owner_edges = knowledge(await space.graph(params, headers=REVIEW))
            g_nodes, g_edges = knowledge(await space.graph({**params, **AS_G}))
            assert space.fla_ids() | visible_to_all <= owner_nodes
            assert {space.fla_edge, space.plain_edge} <= owner_edges
            assert g_nodes == owner_nodes and g_edges == owner_edges, 'G reads its own knowledge in full'
            for reader in (AS_H, {}):
                nodes, edges = knowledge(await space.graph({**params, **reader}))
                assert not nodes & space.fla_ids(), reader
                assert visible_to_all <= nodes
                # The plain edge points at G's fact: it goes with its endpoint.
                assert not edges & {space.fla_edge, space.plain_edge}, reader
        page = await space.graph({'offset': 0, 'limit': 1, **AS_H})
        assert not {node['id'] for node in page['nodes']} & space.fla_ids(), 'hidden before the page is cut'
        # A project preference is everyone's, but G's own words as its evidence stay G's.

        def words(graph):
            habit = next(node for node in graph['nodes'] if node['id'] == space.id('shared-habit'))
            return [source.get('source_excerpt') for source in habit['evidence']]
        g_words = 'G words about leading with the conclusion'
        assert g_words in words(await space.graph(headers=REVIEW))
        assert g_words in words(await space.graph(AS_G))
        for reader in (AS_H, {}):
            excerpts = words(await space.graph(reader))
            assert g_words not in excerpts and len(excerpts) == 1, reader


@pytest.mark.asyncio
async def test_a_graph_reader_proves_itself_or_is_refused():
    settings = reviewed_settings()
    async with provider_client(settings) as (client, _):
        space = await Boundary().build(client, settings)
        wrong = await client.get(f'/v1/spaces/{space.space_id}/graph', headers=WRONG_PROOF)
        assert wrong.status_code == 403
        unassigned = await client.get(f'/v1/spaces/{space.space_id}/graph', params={
            'reader_project_id': PROJECT, 'reader_agent_id': 'synthetic-unassigned'})
        assert unassigned.status_code == 404
        no_project = await client.get(f'/v1/spaces/{space.space_id}/graph', params={'reader_agent_id': G})
        assert no_project.status_code == 422


@pytest.mark.asyncio
async def test_an_item_view_hides_another_flas_item_its_words_and_its_versions():
    settings = reviewed_settings()
    async with provider_client(settings) as (client, _):
        space = await Boundary().build(client, settings)
        for key in ('fla-fact', 'fla-habit'):
            assert (await space.view(key, headers=REVIEW)).status_code == 200
            assert (await space.view(key, AS_G)).status_code == 200
            for reader in (AS_H, None):
                hidden = await space.view(key, reader)
                assert (hidden.status_code, hidden.json()['detail']) == (404, 'knowledge item not found')
        assert (await space.view('fla-fact', headers=WRONG_PROOF)).status_code == 403
        # A project preference is everyone's in the project, but G's own words as its evidence stay G's.
        owner = ok(await space.view('shared-habit', headers=REVIEW))
        as_g = ok(await space.view('shared-habit', AS_G))
        as_h = ok(await space.view('shared-habit', AS_H))
        g_words = 'G words about leading with the conclusion'
        assert owner['evidence_count'] == as_g['evidence_count'] == 2
        assert g_words in {source['excerpt'] for source in owner['evidence']}
        assert as_h['evidence_count'] == 1 and g_words not in {source['excerpt'] for source in as_h['evidence']}
        assert as_h['weight']['basis']['source_count'] == 1
        # The plain item replaced G's older one: only G and the person see that version.
        versions = lambda view: {version['item_id'] for version in view['versions']}  # noqa: E731
        assert space.id('fla-old') in versions(ok(await space.view('plain-new', headers=REVIEW)))
        assert space.id('fla-old') in versions(ok(await space.view('plain-new', AS_G)))
        for reader in (AS_H, None):
            assert versions(ok(await space.view('plain-new', reader))) == {space.id('plain-new')}


@pytest.mark.asyncio
async def test_a_receipt_lists_and_counts_nothing_of_another_flas_turn():
    settings = reviewed_settings()
    async with provider_client(settings) as (client, _):
        space = await Boundary().build(client, settings)
        owner = await space.receipt(space.fla['episode_id'], headers=REVIEW)
        own = await space.receipt(space.fla['episode_id'], AS_G)
        listed = {entry['item_id'] for entry in owner['entries']}
        assert space.fla_ids() <= listed and space.fla_edge in listed
        assert {entry['item_id'] for entry in own['entries']} == listed
        for reader in (AS_H, None):
            assert await space.receipt(space.fla['episode_id'], reader) == {
                'entries': [], 'unchanged_count': 0, 'deleted_count': 0, 'deletion_ids': []}
        # G's later turn names a plain item again: the person counts it, H does not see that turn at all.
        again = await commit(client, space.space_id, [entity('fla-fact', 'G deploys through the canary lane')], agent=G)
        assert (await space.receipt(again['episode_id'], headers=REVIEW))['unchanged_count'] == 1
        assert (await space.receipt(again['episode_id'], AS_H))['unchanged_count'] == 0


@pytest.mark.asyncio
async def test_a_sessions_records_hold_none_of_another_flas_knowledge():
    settings = reviewed_settings()
    async with provider_client(settings) as (client, _):
        space = await Boundary().build(client, settings)
        session = Session(client, space.space_id, f'native-{uuid4()}')
        await session.begin(PROJECT, G)
        fla = await commit(client, space.space_id, [entity('session-fla', 'G keeps the release notes')], agent=G,
                           session_id=session.session_id)
        await session.checkpoint(fla)
        await session.begin(PROJECT, G)
        plain = await commit(client, space.space_id, [entity('session-plain', 'Release notes live in docs')],
                             session_id=session.session_id)
        await session.checkpoint(plain)

        async def items(reader=None, headers=None):
            records = ok(await client.post('/v1/session-records', headers=headers, json={
                'personal_space_id': space.space_id, 'source_application': 'codex',
                'session_id': session.session_id, **(reader or {})}))
            return {item['content'] for item in records['items']}

        both = {'G keeps the release notes', 'Release notes live in docs'}
        assert await items(headers=REVIEW) == both
        assert await items(AS_G) == both
        assert await items(AS_H) == await items() == {'Release notes live in docs'}


@pytest.mark.asyncio
async def test_the_ai_review_never_reviews_an_flas_own_knowledge():
    settings = reviewed_settings()
    async with provider_client(settings) as (client, _):
        space = await Boundary().build(client, settings)
        run = ok(await client.post('/v1/knowledge/reviews/start', json={
            'personal_space_id': space.space_id, 'scope': 'project', 'personal_project_id': PROJECT,
            'reviewer': 'tonborg'}))
        page = ok(await client.post('/v1/knowledge/reviews/candidates', json={
            'personal_space_id': space.space_id, 'review_id': run['review_id'], 'limit': 100}))
        candidates = {candidate['item_id'] for candidate in page['candidates']}
        assert space.id('plain-fact') in candidates
        assert not candidates & (space.fla_ids() | {space.fla_edge})
        progress = await client.post('/v1/knowledge/reviews/progress', json={
            'personal_space_id': space.space_id, 'review_id': run['review_id'],
            'candidate_key': f"entity:{space.id('fla-fact')}", 'outcome': 'ai_reviewed',
            'ai_review_evidence_token': 'a' * 64,
            'ai_assessment': {'outcome': 'approve', 'summary': 'Synthetic.', 'evidence': ['Synthetic.'],
                              'confidence': 0.9, 'client': 'codex', 'model': 'synthetic-review-model'}})
        assert progress.status_code == 404, progress.text
