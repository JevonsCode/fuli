"""Deleted evidence is explicit in the authorized detail read, without its words."""
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from fuli_graph import knowledge_item_view as views
from fuli_graph import knowledge_basis_review as review
from fuli_graph import knowledge_source_delete_mutation as mutation
from fuli_graph.knowledge_item_view_models import KnowledgeItemRef, KnowledgeItemSummary

# The person's console read: it carries the human-review proof.
CONSOLE = {'_human_review_verified': True}


@pytest.mark.asyncio
async def test_detail_reports_only_unresolved_deleted_sources_and_clears_after_review(monkeypatch):
    current = {'unresolved_bases': ['episode@deletion', 'knowledge@another-change']}
    driver = SimpleNamespace(execute_query=AsyncMock(return_value=(
        [{'episode_id': 'episode', 'deletion_id': 'deletion'}], None, None)))
    store = SimpleNamespace(runtime=SimpleNamespace(driver=driver))
    monkeypatch.setattr(views, 'personal_reader_space', AsyncMock(return_value={'id': 'space'}))
    monkeypatch.setattr(views, 'require_not_hard_deleted', AsyncMock())
    monkeypatch.setattr(views, '_read_item', AsyncMock(return_value=current))
    monkeypatch.setattr(views, 'item_evidence', AsyncMock(return_value=([], [])))
    monkeypatch.setattr(views, 'item_revisions', AsyncMock(return_value={}))
    monkeypatch.setattr(views, 'version_chain', AsyncMock(return_value=[]))
    monkeypatch.setattr(views, 'dependents_of', AsyncMock(return_value=[]))
    monkeypatch.setattr(views, 'item_bases', AsyncMock(return_value=[]))
    summary = KnowledgeItemSummary(item_kind='entity', item_id='kept', version=1, title='kept',
        content='Retained conclusion', type='Entity', category='knowledge', scope={'kind': 'global'},
        confirmation_status='confirmed')
    monkeypatch.setattr(views, 'item_summary', AsyncMock(return_value=summary))
    request = KnowledgeItemRef(personal_space_id='space', item_kind='entity', item_id='kept')
    detail = await views.read_knowledge_item_view(store, CONSOLE, request)
    assert detail.model_dump()['unavailable_sources'] == [
        {'episode_id': 'episode', 'deletion_id': 'deletion', 'status': 'unavailable'}]
    assert detail.basis_review == 'changed' and detail.evidence == []
    assert driver.execute_query.call_args.kwargs['space_id'] == 'space'
    assert driver.execute_query.call_args.kwargs['reasons'] == current['unresolved_bases']
    current['unresolved_bases'] = []
    detail = await views.read_knowledge_item_view(store, CONSOLE, request)
    assert detail.unavailable_sources == [] and detail.basis_review is None
    assert driver.execute_query.await_count == 1


@pytest.mark.asyncio
async def test_retained_source_marks_existing_review_reason_and_revision_once(monkeypatch):
    current = {'unresolved_bases': [], 'name': 'Retained conclusion'}
    monkeypatch.setattr(review, '_read_item', AsyncMock(return_value=current))
    monkeypatch.setattr(review, '_snapshot', lambda value, kind: {'name': value['name']})
    add = AsyncMock()
    record = AsyncMock()
    monkeypatch.setattr(review, '_add_reason', add)
    monkeypatch.setattr(review, '_record', record)
    now = datetime.now(timezone.utc)
    await review.hold_deleted_sources(None, {}, {}, 'entity', 'kept', ['episode'], 'deletion', now)
    assert add.call_args.args[-1] == 'episode@deletion'
    assert record.call_args.args[5] == 'basis_changed'
    assert record.call_args.args[-1] == ('episode', 'episode')
    current['unresolved_bases'] = ['episode@deletion']
    await review.hold_deleted_sources(None, {}, {}, 'entity', 'kept', ['episode'], 'deletion', now)
    assert add.await_count == 1 and record.await_count == 1


@pytest.mark.asyncio
async def test_mutation_holds_unchecked_sole_source_but_not_retained_multisource(monkeypatch):
    mark = AsyncMock()
    propagate = AsyncMock()
    monkeypatch.setattr(mutation, 'hold_deleted_sources', mark)
    monkeypatch.setattr(mutation, 'apply_meaning', propagate)
    plan = {'selection': {'selected_keys': ['entity:deleted'],
                         'retained_sources': {'entity:kept': [], 'entity:multi': ['other']}},
            'inventory': {'episodes': [{'uuid': 'source'}]},
            'lineages': [{'key': key, 'source_episode_ids': sources} for key, sources in (
                ('entity:deleted', ['source']), ('entity:kept', ['source']),
                ('entity:multi', ['source', 'other']))]}
    await mutation.hold_source_bases(None, {}, {}, plan, 'deletion', datetime.now(timezone.utc))
    assert mark.await_count == 1 and mark.call_args.args[4] == 'kept'
    assert mark.call_args.args[5] == {'source'}
    assert [call.args[4] for call in propagate.call_args_list] == ['deleted', 'kept']
