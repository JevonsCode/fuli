"""A visitor's search leaves out knowledge whose sources are all private or
restricted (max_sensitivity='normal'); every other search is unchanged.
Synthetic records only; the graph semantics run in
test_knowledge_sensitivity_neo4j.py."""

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from fuli_graph.knowledge_search import _scoped_entity_records, search_knowledge
from fuli_graph.models import SearchRequest
from fuli_graph.project_agent_remote_origins import AgentRemoteOriginIssue

SENSITIVITY_QUERY = 'episode.fuli_sensitivity'


def edge(uuid):
    return SimpleNamespace(
        uuid=uuid, group_id='project-group', name='DOCUMENTS',
        fact='Synthetic deploy checklist lives in the runbook',
        source_node_uuid='source', target_node_uuid='target',
        valid_at=None, invalid_at=None, created_at=datetime(2026, 11, 1, tzinfo=timezone.utc),
        episodes=[f'{uuid}-episode'],
    )


class Driver:
    """Answers the sensitivity query with the relationships that have a normal source."""

    def __init__(self, normal_ids):
        self.normal_ids = normal_ids
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        if SENSITIVITY_QUERY in query:
            return [{'id': item} for item in self.normal_ids if item in parameters['edge_ids']], None, None
        if 'MATCH (n:Entity)' in query:
            return [{'uuid': 'source', 'name': 'Synthetic runbook'},
                    {'uuid': 'target', 'name': 'Synthetic deploy'}], None, None
        return [], None, None


class Store:
    def __init__(self, edges, driver):
        self.runtime = SimpleNamespace(graphiti=self, driver=driver)
        self.edges = edges

    async def search(self, query, *, group_ids, num_results):
        del query, group_ids, num_results
        return self.edges

    async def authorize(self, actor, space_id, role):
        del actor, role
        return {'id': space_id, 'kind': 'project', 'group_id': 'project-group'}


def request(**fields):
    return SearchRequest(space_ids=['project-space'], query='deploy checklist', include_pending=True, **fields)


async def test_a_relationship_whose_sources_are_all_private_is_left_out():
    driver = Driver(normal_ids=['edge-normal'])
    store = Store([edge('edge-normal'), edge('edge-private')], driver)
    result = await search_knowledge(store, {'id': 'actor'}, request(max_sensitivity='normal'))
    assert [fact.id for fact in result.facts] == ['edge-normal']
    [(query, parameters)] = [call for call in driver.calls if SENSITIVITY_QUERY in call[0]]
    assert parameters['edge_ids'] == ['edge-normal', 'edge-private']
    assert "coalesce(episode.fuli_sensitivity, 'normal') = 'normal'" in query


async def test_the_default_search_never_filters_by_sensitivity():
    driver = Driver(normal_ids=[])
    store = Store([edge('edge-normal'), edge('edge-private')], driver)
    result = await search_knowledge(store, {'id': 'actor'}, request())
    assert sorted(fact.id for fact in result.facts) == ['edge-normal', 'edge-private']
    assert not any(SENSITIVITY_QUERY in query for query, _ in driver.calls)


@pytest.mark.parametrize('max_sensitivity', [None, 'normal'])
async def test_entities_are_filtered_only_when_a_visitor_asks(max_sensitivity):
    driver = Driver(normal_ids=[])
    store = SimpleNamespace(runtime=SimpleNamespace(driver=driver), settings=SimpleNamespace(graph_limit=100))
    space = {'id': 'personal-space', 'group_id': 'personal-group'}
    await _scoped_entity_records(store, space, SearchRequest(
        space_ids=['personal-space'], query='deploy', personal_project_ids=['project'],
        max_sensitivity=max_sensitivity), {})
    [(query, parameters)] = driver.calls
    assert parameters['max_sensitivity'] == max_sensitivity
    assert ("$max_sensitivity IS NULL OR any(episode IN episodes WHERE "
            "coalesce(episode.fuli_sensitivity, 'normal') = 'normal')") in query


def test_max_sensitivity_is_normal_or_absent():
    assert SearchRequest(space_ids=['s'], query='q').max_sensitivity is None
    for value in ('private', 'restricted', ''):
        with pytest.raises(ValidationError):
            SearchRequest(space_ids=['s'], query='q', max_sensitivity=value)


def test_a_remote_origin_may_be_issued_for_a_query_or_a_request():
    issue = dict(personal_space_id='space', task_context_token='token', source_application='codex',
                 message_id='message-1', digest='a' * 64, target_node='b' * 64, binding_id='binding',
                 expires_at='2026-11-14T00:00:00.000Z')
    for purpose in ('execution', 'chat', 'query', 'request'):
        assert AgentRemoteOriginIssue(**issue, purpose=purpose).purpose == purpose
    assert AgentRemoteOriginIssue(**issue).purpose == 'execution'
    with pytest.raises(ValidationError):
        AgentRemoteOriginIssue(**issue, purpose='trusted')
