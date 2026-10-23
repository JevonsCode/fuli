"""D-31.B1: selection rules independent of graph storage and UI."""
import pytest

from fuli_graph.knowledge_source_delete_selection import source_delete_selection


def item(key, sources, *, versions=(), dependents=(), attached=()):
    return {'key': key, 'version_keys': [key, *versions], 'source_episode_ids': sources,
            'dependent_keys': list(dependents), 'attached_keys': list(attached)}


def test_default_scope_removes_whole_lineages_and_keeps_multisource_and_derived():
    items = [item('entity:sole', ['turn'], versions=['entity:old'], dependents=['entity:conclusion'],
                  attached=['relationship:edge']),
             item('entity:multi', ['turn', 'elsewhere']),
             item('relationship:edge', ['turn', 'elsewhere']),
             item('entity:conclusion', ['other-session'], dependents=['entity:next']),
             item('entity:next', ['third-session'])]
    result = source_delete_selection(items, ['turn'])
    assert result['deleted_keys'] == ['entity:old', 'entity:sole', 'relationship:edge']
    assert result['review_keys'] == ['entity:conclusion', 'entity:next']
    assert result['retained_sources'] == {'entity:multi': ['elsewhere']}


def test_unchecked_sole_source_is_retained_but_unavailable_and_propagates():
    result = source_delete_selection([
        item('entity:sole', ['turn'], dependents=['entity:conclusion']),
        item('entity:conclusion', ['other'])], ['turn'], exclude=['entity:sole'])
    assert result['deleted_keys'] == []
    assert result['review_keys'] == ['entity:conclusion', 'entity:sole']
    assert result['retained_sources'] == {'entity:sole': []}


def test_including_affected_item_expands_deletion_and_recomputes_dependencies():
    items = [item('entity:multi', ['turn', 'elsewhere'], dependents=['entity:conclusion']),
             item('entity:conclusion', ['other'], dependents=['entity:next']),
             item('entity:next', ['another'])]
    baseline = source_delete_selection(items, ['turn'])
    assert baseline['review_keys'] == []
    included = source_delete_selection(items, ['turn'], include=['entity:multi', 'entity:conclusion'])
    assert included['deleted_keys'] == ['entity:conclusion', 'entity:multi']
    assert included['review_keys'] == ['entity:next']


def test_selection_cannot_smuggle_unrelated_ids_or_keep_attached_relationship_without_endpoint():
    items = [item('entity:sole', ['turn'], attached=['relationship:edge']),
             item('relationship:edge', ['turn']), item('entity:unrelated', ['elsewhere'])]
    with pytest.raises(ValueError, match='outside'):
        source_delete_selection(items, ['turn'], include=['entity:unrelated'])
    with pytest.raises(ValueError, match='endpoint'):
        source_delete_selection(items, ['turn'], exclude=['relationship:edge'])


def test_duplicate_versions_and_dependency_cycles_are_deterministic():
    items = [item('entity:a', ['turn'], versions=['entity:a-old'], dependents=['entity:b']),
             item('entity:b', ['other'], dependents=['entity:a'])]
    result = source_delete_selection(items, ['turn', 'turn'], include=['entity:b'])
    assert result['deleted_keys'] == ['entity:a', 'entity:a-old', 'entity:b']
    assert result['review_keys'] == []


def test_attached_multisource_relationship_can_be_kept_when_its_endpoint_is_kept():
    result = source_delete_selection([
        item('entity:sole', ['turn'], attached=['relationship:edge']),
        item('relationship:edge', ['turn', 'other'])], ['turn'],
        exclude=['entity:sole', 'relationship:edge'])
    assert result['default_keys'] == ['entity:sole', 'relationship:edge']
    assert result['deleted_keys'] == []
    assert result['review_keys'] == ['entity:sole']
    assert result['retained_sources']['relationship:edge'] == ['other']
