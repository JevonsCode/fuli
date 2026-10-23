"""Source selection and draft state changes are rebound into the reviewed plan."""
from types import SimpleNamespace

import pytest

from fuli_graph import knowledge_source_delete_plan as planner
from fuli_graph.knowledge_hard_delete_models import KnowledgeHardDeleteItem
from fuli_graph.knowledge_source_delete_models import SourceDeleteRef


@pytest.mark.asyncio
async def test_plan_keeps_other_sources_and_rebinds_user_selection_and_draft_status(monkeypatch):
    target = SimpleNamespace(source_application='codex', session_id='session')
    inventory = dict(episodes=[{'uuid': 'episode', 'fuli_source_excerpt': 'Synthetic turn'}],
        task_ids=['task'], task_versions=[['task', 'digest']], event_ids=['event'], event_versions=[['event', 'digest']],
        conversation_ids=['conversation'], conversation_versions=[['conversation', 1]])
    lineages = [dict(key='entity:sole', version_keys=['entity:sole', 'entity:old'], source_episode_ids=['episode'],
        dependent_keys=['entity:derived'], attached_keys=[]),
        dict(key='entity:multiple', version_keys=['entity:multiple'], source_episode_ids=['episode', 'other'],
            dependent_keys=[], attached_keys=[]),
        dict(key='entity:derived', version_keys=['entity:derived'], source_episode_ids=['other'],
            dependent_keys=[], attached_keys=[])]
    drafts = [{'draft': {'id': 'draft', 'status': 'pending'}, 'source_identity': {'episode_id': 'episode'}}]
    async def resolved(*args): return target
    async def inventoried(*args): return inventory
    async def connected(*args): return lineages
    async def copies(*args, **kwargs): return drafts
    async def published(*args, **kwargs): return []
    monkeypatch.setattr(planner, 'source_delete_target', resolved)
    monkeypatch.setattr(planner, 'source_delete_inventory', inventoried)
    monkeypatch.setattr(planner, 'source_delete_lineages', connected)
    monkeypatch.setattr(planner, 'drafts_for_sources', copies)
    monkeypatch.setattr(planner, 'publications_for_sources', published)
    async def item_rows(store, space, keys):
        return ([KnowledgeHardDeleteItem(item_kind='entity', item_id=key.split(':')[1], role='item',
            title='Synthetic knowledge', content='Synthetic words', status='current') for key in keys],
            [[key, 0] for key in keys])
    async def record_ids(store, space, items):
        return {'revisions': [item.item_id for item in items]}
    knowledge = SimpleNamespace(item_rows=item_rows, record_ids=record_ids)
    request = SourceDeleteRef(personal_space_id='space', item_kind='episode')
    plan = await planner.plan_source_delete(None, {'id': 'space'}, 'episode', request, knowledge)
    preview = plan['preview']
    assert [row.key for row in preview.default_items] == ['entity:sole']
    assert len(preview.default_items[0].versions) == 2
    affected = {row.key: row for row in preview.affected_items}
    assert not affected['entity:multiple'].basis_changed
    assert affected['entity:multiple'].retained_source_count == 1
    assert affected['entity:derived'].basis_changed
    assert preview.drafts.pending == 1 and preview.drafts.submitted == 0
    retained = await planner.plan_source_delete(None, {'id': 'space'}, 'episode',
        request.model_copy(update={'exclude': ['entity:sole']}), knowledge)
    assert retained['preview'].default_items[0].basis_changed
    assert not retained['preview'].default_items[0].selected
    assert retained['preview'].preview_id != preview.preview_id
    drafts[0]['draft']['status'] = 'submitted'
    changed = await planner.plan_source_delete(None, {'id': 'space'}, 'episode', request, knowledge)
    assert changed['preview'].preview_id != preview.preview_id
    assert changed['preview'].drafts.submitted == 1
    # TTL affects the warning, never the stored-state digest. A different
    # reservation attempt must invalidate a previous confirmation.
    from datetime import datetime, timedelta, timezone
    at = datetime(2026, 10, 23, tzinfo=timezone.utc)
    drafts[0]['draft'].update(status='submitting', submission_id='attempt', submission_started_at=at)
    monkeypatch.setattr(planner, 'now_utc', lambda: at)
    fresh = await planner.plan_source_delete(None, {'id': 'space'}, 'episode', request, knowledge)
    monkeypatch.setattr(planner, 'now_utc', lambda: at + timedelta(seconds=121))
    expired = await planner.plan_source_delete(None, {'id': 'space'}, 'episode', request, knowledge)
    assert fresh['preview'].drafts.submitting == 1 and expired['preview'].drafts.unknown == 1
    assert fresh['preview'].preview_id == expired['preview'].preview_id
    drafts[0]['draft']['submission_id'] = 'another-attempt'
    rebound = await planner.plan_source_delete(None, {'id': 'space'}, 'episode', request, knowledge)
    assert rebound['preview'].preview_id != expired['preview'].preview_id
