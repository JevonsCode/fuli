"""Read-only full-text export of a synthetic hard-delete plan."""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph import knowledge_hard_delete as deletion
from fuli_graph.knowledge_hard_delete_models import (
    KnowledgeHardDeleteCounts, KnowledgeHardDeleteEpisode, KnowledgeHardDeleteExport,
    KnowledgeHardDeleteItem, KnowledgeHardDeletePreview,
)


class Driver:
    def __init__(self):
        self.queries = []
        self.source_content = 'full-source-' * 100

    async def execute_query(self, query, **params):
        self.queries.append((query, params))
        assert params['group_id'] == 'synthetic-group'
        assert params['routing_'] == 'r'
        if query == deletion._ITEM_ROWS['entity']:
            return ([{'item_id': item_id, 'content': item_id * 350} for item_id in params['item_ids']], None, None)
        if query == deletion._ITEM_ROWS['relationship']:
            return ([{'item_id': 'fact', 'content': 'full fact ' * 100}], None, None)
        assert 'episode.content AS content' in query
        assert params['episode_ids'] == ['removed']
        return ([{'episode_id': 'removed', 'content': self.source_content}], None, None)


@pytest.mark.asyncio
async def test_export_full_text_and_reject_stale_without_writes(monkeypatch):
    digest = 'a' * 64
    preview = KnowledgeHardDeletePreview(
        preview_id=digest, item_kind='entity', item_id='item', title='Synthetic',
        items=[KnowledgeHardDeleteItem(item_kind='entity', item_id=item_id, role=role, title=item_id,
                                      content='excerpt', status='current')
               for item_id, role in [('item', 'item'), ('old', 'version')]] + [
            KnowledgeHardDeleteItem(item_kind='relationship', item_id='fact', role='relationship', title='fact',
                                    content='excerpt', status='current')],
        removed_episodes=[KnowledgeHardDeleteEpisode(episode_id='removed', excerpt='short')],
        kept_episodes=[KnowledgeHardDeleteEpisode(episode_id='kept', excerpt='kept excerpt')],
        dependents=[], counts=KnowledgeHardDeleteCounts())
    driver = Driver()
    store = SimpleNamespace(runtime=SimpleNamespace(driver=driver))
    plans = []

    async def person_space(_store, actor, space_id):
        assert actor == {'id': 'owner'} and space_id == 'space'
        return {'id': space_id, 'group_id': 'synthetic-group'}

    async def plan(_store, _space, item_id, request):
        assert item_id == 'item' and request.item_kind == 'entity'
        return {'preview': plans.pop(0) if plans else preview}

    monkeypatch.setattr(deletion, '_person_space', person_space)
    monkeypatch.setattr(deletion, '_plan_request', plan)
    request = KnowledgeHardDeleteExport(personal_space_id='space', item_kind='entity', preview_id=digest)
    result = await deletion.export_hard_delete(store, {'id': 'owner'}, 'item', request)
    assert [item['content'] for item in result['items']] == ['item' * 350, 'old' * 350, 'full fact ' * 100]
    assert result['removed_episodes'][0]['content'] == 'full-source-' * 100
    assert result['kept_episodes'] == [preview.kept_episodes[0].model_dump(mode='json')]
    assert len(driver.queries) == 3
    assert all(not any(word in query.upper().split() for word in ('SET', 'DELETE', 'CREATE', 'MERGE'))
               for query, _ in driver.queries)

    stale = preview.model_copy(update={'preview_id': 'b' * 64})
    for sequence in ([stale], [preview, stale]):
        plans[:] = sequence
        with pytest.raises(HTTPException) as refused:
            await deletion.export_hard_delete(store, {'id': 'owner'}, 'item', request)
        assert refused.value.status_code == 409
        assert refused.value.detail['code'] == 'hard_delete_preview_stale'

    for missing in (None, ''):
        driver.source_content = missing
        with pytest.raises(HTTPException) as unavailable:
            await deletion.export_hard_delete(store, {'id': 'owner'}, 'item', request)
        assert unavailable.value.detail['code'] == 'hard_delete_export_content_unavailable'
