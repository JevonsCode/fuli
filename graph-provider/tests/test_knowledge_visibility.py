"""The FLA read boundary without a graph: who may read FLA-scoped knowledge,
and that every read path asks the same rule. Synthetic records only."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from fuli_graph import knowledge_visibility as visibility
from fuli_graph import knowledge_item_view as views
from fuli_graph.graph_query import _edge_query, _node_query
from fuli_graph.knowledge_item_view_models import KnowledgeItemRef, KnowledgeTurnReceiptRead
from fuli_graph.knowledge_review import build_review_candidates
from fuli_graph.knowledge_visibility import PLAIN_SESSION, AgentReader, fla_visible

G = AgentReader('alpha', 'agent-g')
H = AgentReader('alpha', 'agent-h')
G_ELSEWHERE = AgentReader('beta', 'agent-g')

FLA_FACT = {'profile_aspect': None, 'episode_project_ids': ['alpha'], 'episode_project_agent_ids': ['agent-g']}
PLAIN_FACT = {'profile_aspect': None, 'episode_project_ids': ['alpha'], 'episode_project_agent_ids': []}
AGENT_PREFERENCE = {'profile_aspect': 'taste', 'preference_scope': 'agent', 'preference_project_id': 'alpha',
                    'preference_agent_id': 'agent-g'}
# A preference follows its own scope; an FLA's episode as its evidence does not make it the FLA's.
PROJECT_PREFERENCE = {'profile_aspect': 'taste', 'preference_scope': 'project', 'preference_project_id': 'alpha',
                      'episode_project_agent_ids': ['agent-g'], 'episode_project_ids': ['alpha']}


@pytest.mark.parametrize('record,visible_to', [
    (FLA_FACT, {'G'}),
    (AGENT_PREFERENCE, {'G'}),
    (PLAIN_FACT, {'G', 'H', 'G elsewhere', 'plain'}),
    (PROJECT_PREFERENCE, {'G', 'H', 'G elsewhere', 'plain'}),
    ({'profile_aspect': 'taste', 'preference_scope': None}, {'G', 'H', 'G elsewhere', 'plain'}),
])
def test_only_that_fla_in_its_project_reads_its_own_knowledge(record, visible_to):
    readers = {'G': G, 'H': H, 'G elsewhere': G_ELSEWHERE, 'plain': PLAIN_SESSION}
    assert {name for name, reader in readers.items() if fla_visible(record, reader)} == visible_to


@pytest.mark.asyncio
async def test_reader_is_the_person_only_with_review_proof_and_an_fla_only_when_authorized(monkeypatch):
    authorize = AsyncMock(return_value={'agent_id': 'agent-g'})
    monkeypatch.setattr(visibility, 'authorize_project_agent', authorize)
    space = {'id': 'space'}
    owner = {'_human_review_verified': True}
    assert await visibility.knowledge_reader(None, owner, space, personal_project_id='alpha',
                                             project_agent_id='agent-g') is None
    assert await visibility.knowledge_reader(None, {}, space, personal_project_id=None,
                                             project_agent_id=None) == PLAIN_SESSION
    assert await visibility.knowledge_reader(None, {}, space, personal_project_id='alpha',
                                             project_agent_id='agent-g') == G
    authorize.assert_awaited_once_with(None, {}, space, 'alpha', 'agent-g')
    # A claimed proof that is not the verified flag is no proof.
    assert await visibility.knowledge_reader(None, {'_human_review_verified': 'yes'}, space,
                                             personal_project_id=None, project_agent_id=None) == PLAIN_SESSION
    authorize.side_effect = HTTPException(status_code=404, detail='project Agent not found')
    with pytest.raises(HTTPException) as refused:
        await visibility.knowledge_reader(None, {}, space, personal_project_id='alpha', project_agent_id='agent-x')
    assert refused.value.status_code == 404


@pytest.mark.parametrize('project_scoped', [False, True])
@pytest.mark.parametrize('paginated', [False, True])
def test_graph_queries_cut_hidden_items_and_edges_to_them_before_the_page(project_scoped, paginated):
    node_query = _node_query(project_scoped, paginated)
    edge_query = _edge_query(project_scoped, paginated)
    assert visibility.fla_visible_cypher('node', 'entity') in node_query
    for item, kind in (('edge', 'relationship'), ('source', 'entity'), ('target', 'entity')):
        assert visibility.fla_visible_cypher(item, kind) in edge_query
    # The filter comes before the page is cut, so a page shows no gap.
    assert node_query.index('fla_episode') < node_query.index('LIMIT $limit')
    assert edge_query.index('fla_episode') < edge_query.index('LIMIT $limit')


def test_the_person_passes_no_reader_and_the_predicate_admits_everything():
    assert visibility.reader_parameter(None) is None
    assert visibility.fla_visible_cypher('node', 'entity').startswith('($reader IS NULL OR')
    assert visibility.fla_episode_visible_cypher('episode').startswith('($reader IS NULL OR')
    assert visibility.reader_parameter(G) == {'personal_project_id': 'alpha', 'project_agent_id': 'agent-g'}


@pytest.mark.asyncio
async def test_the_person_reads_without_a_visibility_query():
    driver = SimpleNamespace(execute_query=AsyncMock())
    store = SimpleNamespace(runtime=SimpleNamespace(driver=driver))
    assert await visibility.hidden_refs(store, {'group_id': 'g'}, None, [('entity', 'x')]) == set()
    assert await visibility.visible_episode_ids(store, {'group_id': 'g'}, None, ['e1']) == ['e1']
    driver.execute_query.assert_not_awaited()


@pytest.mark.asyncio
async def test_an_agent_gets_hidden_refs_per_kind_and_keeps_episode_order():
    async def execute_query(query, **parameters):
        assert parameters['reader'] == {'personal_project_id': 'alpha', 'project_agent_id': 'agent-h'}
        if 'MATCH (episode:Episodic' in query:
            return [{'id': 'e2'}], None, None
        hidden = {'entity': ['x'], 'relationship': ['r']}['entity' if 'MATCH (item:Entity' in query else 'relationship']
        return [{'id': item} for item in hidden if item in parameters['item_ids']], None, None
    store = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=execute_query)))
    space = {'group_id': 'g'}
    assert await visibility.hidden_refs(store, space, H, [('entity', 'x'), ('entity', 'y'), ('relationship', 'r')]) == {
        ('entity', 'x'), ('relationship', 'r')}
    assert await visibility.visible_episode_ids(store, space, H, ['e1', 'e2', 'e3']) == ['e1', 'e3']


@pytest.mark.asyncio
async def test_a_relationship_by_id_is_hidden_with_either_endpoint_as_in_the_graph():
    queries = []

    async def execute_query(query, **parameters):
        queries.append(query)
        return [], None, None
    store = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=execute_query)))
    await visibility.hidden_refs(store, {'group_id': 'g'}, H, [('relationship', 'r')])
    rule = visibility.fla_relationship_visible_cypher('item', 'source', 'target')
    assert rule in queries[0] and 'MATCH (source:Entity)-[item:RELATES_TO' in queries[0]
    for part in (visibility.fla_visible_cypher('item', 'relationship'), visibility.fla_visible_cypher('source', 'entity'),
                 visibility.fla_visible_cypher('target', 'entity')):
        assert part in rule
    assert visibility.fla_relationship_visible_cypher('edge', 'source', 'target') in _edge_query(False, True)


@pytest.mark.asyncio
async def test_session_turns_and_episodes_are_cut_to_the_readers_own_fla_before_their_page(monkeypatch):
    from fuli_graph import session_records
    from fuli_graph.session_records_models import SessionRecordsRead
    calls = []

    async def execute_query(query, **parameters):
        calls.append((query, parameters))
        return [], None, None
    store = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=execute_query)),
                            _task_session_id=lambda *parts: 'session-node')
    monkeypatch.setattr(session_records, 'personal_reader_space', AsyncMock(return_value={'id': 's', 'group_id': 'g'}))
    monkeypatch.setattr(session_records, 'request_reader', AsyncMock(return_value=H))
    await session_records.read_session_records(store, {}, SessionRecordsRead(
        personal_space_id='s', source_application='codex', session_id='native'))
    tasks = next(query for query, _ in calls if 'FuliTaskContext)' in query)
    episodes = next(query for query, _ in calls if 'MATCH (episode:Episodic' in query)
    turn_rule = visibility.fla_own_work_cypher('task.project_agent_id', 'task.personal_project_id')
    episode_rule = visibility.fla_own_work_cypher('episode.fuli_project_agent_id', 'episode.fuli_personal_project_id')
    assert tasks.index(turn_rule) < tasks.index('LIMIT $limit')
    assert episodes.index(episode_rule) < episodes.index('LIMIT $limit')
    assert all(parameters['reader'] == visibility.reader_parameter(H) for query, parameters in calls
               if query in (tasks, episodes))


def review_row(item_id, **fields):
    return {'item_id': item_id, 'item_kind': 'entity', 'title': item_id, 'content': f'Synthetic {item_id}',
            'profile_aspect': None, 'preference_scope': None, 'assigned_project_ids': ['alpha'],
            'confirmation_status': 'pending', **fields}


def test_review_candidates_leave_out_fla_knowledge_and_agent_preferences():
    rows = [
        review_row('plain'),
        review_row('fla-fact', episode_project_agent_ids=['agent-g']),
        review_row('agent-preference', profile_aspect='taste', preference_scope='agent',
                   preference_project_id='alpha', preference_agent_id='agent-g'),
        review_row('project-preference', profile_aspect='taste', preference_scope='project',
                   preference_project_id='alpha', episode_project_agent_ids=['agent-g']),
    ]
    for scope in ('all', 'project', 'projects_all'):
        candidates = build_review_candidates(
            rows, scope=scope, personal_project_id='alpha', previous_completed_at=None,
            conflict_item_keys=set(), decided_candidate_keys=set())
        assert {candidate.item_id for candidate in candidates} == {'plain', 'project-preference'}, scope


@pytest.mark.asyncio
async def test_an_agent_asking_for_a_ranking_explanation_is_refused_before_any_item_read(monkeypatch):
    monkeypatch.setattr(views, 'personal_reader_space', AsyncMock(return_value={'id': 'space', 'group_id': 'g'}))
    read_item = AsyncMock()
    monkeypatch.setattr(views, '_read_item', read_item)
    request = KnowledgeItemRef(personal_space_id='space', item_kind='entity', item_id='x', query_tags={
        'space_ids': ['space'], 'query': 'deployment'})
    with pytest.raises(HTTPException) as refused:
        await views.read_knowledge_item_view(SimpleNamespace(), {}, request)
    assert refused.value.status_code == 403
    read_item.assert_not_awaited()


@pytest.mark.asyncio
async def test_an_agent_sees_another_flas_item_as_missing(monkeypatch):
    monkeypatch.setattr(views, 'personal_reader_space', AsyncMock(return_value={'id': 'space', 'group_id': 'g'}))
    monkeypatch.setattr(views, 'require_not_hard_deleted', AsyncMock())
    monkeypatch.setattr(views, '_read_item', AsyncMock(return_value={'name': 'Synthetic FLA fact'}))
    monkeypatch.setattr(views, 'hidden_refs', AsyncMock(return_value={('entity', 'x')}))
    evidence = AsyncMock()
    monkeypatch.setattr(views, 'item_evidence', evidence)
    request = KnowledgeItemRef(personal_space_id='space', item_kind='entity', item_id='x')
    with pytest.raises(HTTPException) as missing:
        await views.read_knowledge_item_view(SimpleNamespace(), {}, request)
    assert (missing.value.status_code, missing.value.detail) == (404, 'knowledge item not found')
    evidence.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_receipt_leaves_out_other_flas_episodes_and_items_and_does_not_count_them(monkeypatch):
    monkeypatch.setattr(views, 'personal_reader_space', AsyncMock(return_value={'id': 'space', 'group_id': 'g'}))
    monkeypatch.setattr(views, 'visible_episode_ids', AsyncMock(return_value=['plain-episode']))
    changes = AsyncMock(return_value=[('entity', 'hidden-again', None), ('entity', 'hidden-new', 'created'),
                                      ('entity', 'seen-again', None)])
    monkeypatch.setattr(views, 'episode_changes', changes)
    monkeypatch.setattr(views, 'hidden_refs', AsyncMock(return_value={('entity', 'hidden-again'),
                                                                       ('entity', 'hidden-new')}))
    deletions = AsyncMock(return_value=[])
    monkeypatch.setattr(views, 'hard_deletions_in_episodes', deletions)
    request = KnowledgeTurnReceiptRead(personal_space_id='space', episode_ids=['plain-episode', 'fla-episode'])
    receipt = await views.read_turn_receipt(SimpleNamespace(), {}, request)
    assert (receipt.entries, receipt.unchanged_count) == ([], 1)
    changes.assert_awaited_once_with(SimpleNamespace(), {'id': 'space', 'group_id': 'g'}, ['plain-episode'])
    assert deletions.await_args.args[2] == ['plain-episode']
