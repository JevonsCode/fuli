"""Source selection uses every version/source, including attached edge chains."""
from types import SimpleNamespace

import pytest

from fuli_graph import knowledge_source_delete_lineages as module
from fuli_graph.knowledge_source_delete_selection import source_delete_selection
from fuli_graph.knowledge_item_view import item_evidence


@pytest.mark.asyncio
async def test_lineages_keep_other_version_sources_and_follow_attached_and_derived_records(monkeypatch):
    async def query(cypher, **params):
        if 'RETURN DISTINCT item_kind' in cypher:
            return ([{'item_kind': 'entity', 'item_id': 'old'}], None, None)
        assert params['entity_ids'] in (['head', 'old'], ['dependent'])
        return ([{'item_id': 'edge'}] if params['entity_ids'][0] == 'head' else [], None, None)

    async def versions(store, space, kind, item_id):
        return [{'item_id': key} for key in (['head', 'old'] if item_id in ('head', 'old') else [item_id])]

    async def evidence(store, space, kind, item_id, limit):
        return [], {'head': ['elsewhere'], 'old': ['turn'], 'edge': ['turn'], 'dependent': ['other-session']}[item_id]

    async def dependents(store, space, kind, item_id):
        return [('entity', 'dependent')] if item_id == 'head' else []

    monkeypatch.setattr(module, 'version_chain', versions)
    monkeypatch.setattr(module, 'item_evidence', evidence)
    monkeypatch.setattr(module, 'dependents_of', dependents)
    store = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=query)))
    rows = await module.source_delete_lineages(store, {'id': 'space', 'group_id': 'group'}, ['turn'])
    result = source_delete_selection(rows, ['turn'])
    assert result['selected_keys'] == ['relationship:edge']
    assert result['retained_sources'] == {'entity:head': ['elsewhere']}
    assert result['review_keys'] == []
    included = source_delete_selection(rows, ['turn'], include=['entity:head'])
    assert included['deleted_keys'] == ['entity:head', 'entity:old', 'relationship:edge']
    assert included['review_keys'] == ['entity:dependent']


@pytest.mark.asyncio
@pytest.mark.parametrize('current_sources', [[], ['turn']])
async def test_legacy_episode_edge_sources_are_counted_by_real_evidence_and_lineage_reads(monkeypatch, current_sources):
    episodes = [
        {'uuid': 'turn', 'group_id': 'group', 'entity_edges': ['edge']},
        {'uuid': 'elsewhere', 'group_id': 'group', 'entity_edges': ['edge']},
        {'uuid': 'foreign', 'group_id': 'other-group', 'entity_edges': ['edge']},
    ]

    async def query(cypher, **params):
        if 'RETURN DISTINCT item_kind' in cypher:
            return [{'item_kind': 'relationship', 'item_id': 'edge'}], None, None
        assert 'AS ids' in cypher and params['item_id'] == 'edge'
        # Model both supported persisted provenance representations. The actual
        # evidence reader builds and executes the query, not a mocked item_evidence.
        legacy = 'episode.entity_edges' in cypher
        selected = [row for row in episodes if row['group_id'] == params['group_id'] and (
            row['uuid'] in current_sources or legacy and params['item_id'] in row['entity_edges'])]
        return [{'ids': [row['uuid'] for row in selected], 'episodes': selected[:params['limit']]}], None, None

    async def versions(*args):
        return [{'item_id': 'edge'}]

    async def dependents(*args):
        return []

    monkeypatch.setattr(module, 'version_chain', versions)
    monkeypatch.setattr(module, 'dependents_of', dependents)
    store = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=query)))
    space = {'id': 'space', 'group_id': 'group'}
    evidence, ids = await item_evidence(store, space, 'relationship', 'edge')
    assert sorted(ids) == ['elsewhere', 'turn']
    assert sorted(row.episode_id for row in evidence) == ['elsewhere', 'turn']
    rows = await module.source_delete_lineages(store, space, ['turn'])
    selected = source_delete_selection(rows, ['turn'])
    assert selected['default_keys'] == [] and selected['selected_keys'] == []
    assert selected['retained_sources'] == {'relationship:edge': ['elsewhere']}
    assert selected['review_keys'] == []
