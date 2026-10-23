"""REC #34 C: synthetic search candidates and the real tag vocabulary port."""
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
import json

import pytest
from graphiti_core.edges import EntityEdge

from fuli_graph.knowledge_search import search_knowledge
from fuli_graph.models import SearchRequest
from knowledge_tag_memory import MemoryVocabulary, SPACE


class SearchFixture:
    def __init__(self):
        self.vocabulary = MemoryVocabulary()
        self.settings = SimpleNamespace(graph_limit=100)
        self.runtime = SimpleNamespace(
            graphiti=SimpleNamespace(search=AsyncMock(return_value=[])), driver=self)
        self.rows = [self.item('ordinary'), self.item('tagged')]

    @staticmethod
    def item(item_id):
        return {'id': item_id, 'group_id': 'synthetic-group', 'name': 'Deployment', 'type': 'ProjectFact',
                'summary': 'Synthetic deployment guidance', 'confirmation_status': 'confirmed',
                'epistemic_status': 'confirmed', 'has_global_episode': True,
                'confirmation_basis_json': json.dumps({
                    'existence_reason': 'Synthetic evidence', 'quadrant_reason': 'Synthetic test',
                    'proposed_by': {'kind': 'agent'}, 'confirmed_by': {'kind': 'user'},
                    'confirmed_at': '2026-10-18T00:00:00Z'}),
                'created_at': datetime(2026, 1, 1, tzinfo=timezone.utc)}

    async def authorize(self, actor, space_id, role):
        assert space_id == SPACE
        return {'id': SPACE, 'kind': 'personal', 'group_id': 'synthetic-group'}

    def knowledge_tag_vocabulary(self):
        return self.vocabulary

    async def execute_query(self, query, **parameters):
        if 'MATCH (node:Entity {group_id:' in query:
            return self.rows, None, None
        return [], None, None

    def tag(self, name, item_id, namespace='personal'):
        tag_id = next((tag['id'] for tag in self.vocabulary.tags.values()
                       if tag['name'] == name and tag['namespace_key'] == namespace), None)
        if tag_id is None:
            tag_id = self.vocabulary.seed([name], namespace_key=namespace)[0]
        self.vocabulary.links[f'link-{item_id}-{tag_id}'] = {
            'id': f'link-{item_id}-{tag_id}', 'space_id': SPACE, 'tag_id': tag_id,
            'item_kind': 'entity', 'item_id': item_id, 'status': 'attached',
            'attached_at': datetime(2026, 1, 1, tzinfo=timezone.utc)}
        return self.vocabulary.tags[tag_id]

    async def search(self, query='deployment', explanations=None):
        return await search_knowledge(self, {'id': 'synthetic-owner'}, SearchRequest(
            space_ids=[SPACE], query=query, include_personal_global=True, limit=10),
            tag_explanations=explanations)


@pytest.mark.asyncio
async def test_active_tag_match_breaks_an_equal_textual_score_tie():
    fixture = SearchFixture()
    fixture.tag('deployment', 'tagged')
    result = await fixture.search()
    assert [row.id for row in result.entities] == ['tagged', 'ordinary']


@pytest.mark.asyncio
async def test_a_merged_tag_word_ranks_its_active_target_links():
    fixture = SearchFixture()
    target = fixture.tag('operations', 'tagged')
    old_id = fixture.vocabulary.seed(['deployment'])[0]
    fixture.vocabulary.tags[old_id].update(status='merged', merged_into_id=target['id'])
    result = await fixture.search()
    assert [row.id for row in result.entities] == ['tagged', 'ordinary']


@pytest.mark.asyncio
async def test_tiers_one_hop_direction_and_maximum_not_sum():
    fixture = SearchFixture()
    ids = ['none', 'provisional', 'child', 'related', 'direct', 'grandchild', 'stacked']
    fixture.rows = [fixture.item(item_id) for item_id in ids]
    root = fixture.tag('deployment', 'direct')
    provisional = fixture.tag('deploy', 'provisional')
    provisional.update(status='provisional')
    child = fixture.tag('child', 'child')
    child.update(parent_ids=[root['id']])
    related = fixture.tag('release', 'related')
    root.update(related_ids=[related['id']])
    grandchild = fixture.tag('grandchild', 'grandchild')
    grandchild.update(parent_ids=[child['id']])
    fixture.tag('deployment', 'stacked')
    fixture.tag('deploy', 'stacked')
    details = {}
    await fixture.search('deployment deploy', details)
    factor = lambda item_id: details['entity', item_id]['multiplier']
    assert factor('direct') == factor('stacked') > factor('child') == factor('related') >= factor('provisional') > 1
    assert factor('grandchild') == factor('none') == 1
    assert 1 <= factor('stacked') <= 1.25
    assert details['entity', 'child']['matches'][0]['inferred']
    assert details['entity', 'provisional']['matches'][0]['unconfirmed']
    # Querying a child never promotes the parent; reverse related still works.
    for row in fixture.rows:
        row['summary'] = 'Synthetic child release deployment guidance'
    details = {}
    await fixture.search('child', details)
    assert details['entity', 'direct']['multiplier'] == 1
    details = {}
    await fixture.search('release', details)
    assert details['entity', 'direct']['matches'][0]['method'] == 'related_to'


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['retired', 'hidden', 'provisional_parent', 'hidden_redirect', 'redirect_cycle'])
async def test_ineligible_tags_do_not_influence_ranking(change):
    fixture = SearchFixture()
    root = fixture.tag('deployment', 'tagged', 'project:secret' if change == 'hidden' else 'personal')
    if change == 'retired':
        root['status'] = 'retired'
    elif change == 'provisional_parent':
        fixture.vocabulary.links.clear()
        root['status'] = 'provisional'
        fixture.tag('child', 'tagged')['parent_ids'] = [root['id']]
    elif change == 'hidden_redirect':
        target = fixture.tag('secret', 'tagged', 'project:secret')
        root.update(status='merged', merged_into_id=target['id'])
    elif change == 'redirect_cycle':
        root.update(status='merged', merged_into_id=root['id'])
    details = {}
    result = await fixture.search(explanations=details)
    assert [row.id for row in result.entities] == ['ordinary', 'tagged']
    assert details['entity', 'tagged']['multiplier'] == 1


@pytest.mark.asyncio
async def test_negative_feedback_cannot_be_cancelled_by_tags_or_stacking():
    fixture = SearchFixture()
    fixture.rows[1]['requires_attention'] = True
    fixture.tag('deployment', 'tagged')
    fixture.tag('deploy', 'tagged')
    details = {}
    result = await fixture.search('deployment deploy', details)
    assert [row.id for row in result.entities] == ['ordinary', 'tagged']
    assert details['entity', 'tagged']['final_score'] < details['entity', 'ordinary']['final_score']
    assert details['entity', 'tagged']['multiplier'] <= 1.25


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['hidden_project', 'pending', 'zero_text_score', 'not_a_candidate'])
async def test_tags_never_add_filtered_or_absent_items(change):
    fixture = SearchFixture()
    fixture.tag('deployment', 'tagged')
    if change == 'hidden_project':
        fixture.rows[1]['assignment_project_id'] = 'secret'
    elif change == 'pending':
        fixture.rows[1]['confirmation_basis_json'] = None
    elif change == 'zero_text_score':
        fixture.rows[1].update(name='Unrelated', summary='Banana')
    else:
        fixture.rows.pop()
    result = await fixture.search()
    assert [row.id for row in result.entities] == ['ordinary']


@pytest.mark.asyncio
async def test_on_demand_explanation_has_ranks_but_search_shape_is_unchanged():
    fixture = SearchFixture()
    baseline = (await fixture.search()).model_dump()
    fixture.tag('deployment', 'tagged')
    details = {}
    explained = (await fixture.search(explanations=details)).model_dump()
    assert baseline.keys() == explained.keys()
    assert baseline['entities'][0].keys() == explained['entities'][0].keys()
    assert details['entity', 'tagged']['original_rank'] == 2
    assert details['entity', 'tagged']['final_rank'] == 1
    assert details['entity', 'ordinary']['no_signal_reason'] == 'no_matching_tag_on_candidate'
    fixture.rows.reverse()
    repeated = (await fixture.search()).model_dump()
    assert repeated == explained


@pytest.mark.asyncio
@pytest.mark.parametrize('status,expected', [('active', 'direct'), ('provisional', 'provisional'), ('proposed', None)])
async def test_alias_governance_is_respected(status, expected):
    fixture = SearchFixture()
    tag = fixture.tag('operations', 'tagged')
    if status == 'proposed':
        tag.update(proposed_aliases=['deployment'], proposed_alias_keys=['deployment'])
    else:
        tag.update(aliases=['deployment'], alias_keys=['deployment'], alias_statuses=[status])
    details = {}
    await fixture.search(explanations=details)
    matches = details['entity', 'tagged']['matches']
    assert (matches[0]['tier'] if matches else None) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize('query,other', [('C++', 'C'), ('node.js', 'node'), ('C#', 'C')])
async def test_punctuation_distinct_tag_identity_is_preserved(query, other):
    fixture = SearchFixture()
    for row in fixture.rows:
        row['summary'] = f'Synthetic {query} guidance'
    fixture.tag(other, 'tagged')
    details = {}
    await fixture.search(query, details)
    assert details['entity', 'tagged']['multiplier'] == 1


class RelationshipFixture(SearchFixture):
    def __init__(self):
        super().__init__()
        self.edges = [EntityEdge(uuid=item_id, group_id='synthetic-group',
                                source_node_uuid='from', target_node_uuid='to',
                                name='DEPLOYMENT', fact='Synthetic deployment guidance',
                                created_at=datetime(2026, 1, 1, tzinfo=timezone.utc))
                      for item_id in ('ordinary', 'tagged')]
        self.runtime.graphiti.search.return_value = self.edges

    async def execute_query(self, query, **parameters):
        if 'MATCH (node:Entity {group_id:' in query:
            return [], None, None
        if 'edge:RELATES_TO' in query:
            return self.rows, None, None
        if 'RETURN n.uuid AS uuid' in query:
            return [{'uuid': 'from', 'name': 'Synthetic start'}, {'uuid': 'to', 'name': 'Synthetic end'}], None, None
        return [], None, None


@pytest.mark.asyncio
async def test_relationships_use_same_signal_and_history_confirmation_filters():
    fixture = RelationshipFixture()
    fixture.tag('deployment', 'tagged')
    for link in fixture.vocabulary.links.values():
        link['item_kind'] = 'relationship'
    details = {}
    result = await fixture.search(explanations=details)
    assert [fact.id for fact in result.facts] == ['tagged', 'ordinary']
    assert details['relationship', 'tagged']['original_rank'] == 2
    assert details['relationship', 'tagged']['final_rank'] == 1
    fixture.rows[1]['confirmation_basis_json'] = None
    result = await fixture.search()
    assert [fact.id for fact in result.facts] == ['ordinary']
    fixture.rows[1] = fixture.item('tagged')
    fixture.edges[1].invalid_at = datetime(2026, 2, 1, tzinfo=timezone.utc)
    result = await fixture.search()
    assert [fact.id for fact in result.facts] == ['ordinary']
