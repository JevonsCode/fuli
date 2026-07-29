from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from fuli_graph.knowledge_audit import (
    record_agent_views,
    record_human_change,
    review_human_change,
    search_human_changes,
)
from fuli_graph.models import (
    KnowledgeAgentReviewCreate,
    KnowledgeAgentViewCreate,
    KnowledgeHumanChangeSearchRequest,
)


@pytest.mark.asyncio
async def test_human_change_starts_a_new_unseen_version():
    driver = SequentialDriver([[{'human_change_version': 3}]])
    store = StoreStub(driver)

    await record_human_change(
        store,
        {'id': 'principal-1'},
        personal_space(),
        'entity-1',
        'entity',
        reason='人工修正分类',
        operation='knowledge_update',
    )

    query, parameters = driver.calls[0]
    assert "item.fuli_human_change_status = 'unseen'" in query
    assert 'coalesce(item.fuli_human_change_version, 0) + 1' in query
    assert parameters['reason'] == '人工修正分类'
    assert parameters['operation'] == 'knowledge_update'


@pytest.mark.asyncio
async def test_agent_view_moves_unseen_human_change_to_viewed_and_keeps_an_event():
    driver = SequentialDriver([[{'audit_id': 'audit-view-1'}]])
    store = StoreStub(driver)

    result = await record_agent_views(
        store,
        {'id': 'principal-1'},
        KnowledgeAgentViewCreate(
            personal_space_id='personal-space',
            tool_name='search_knowledge_graph',
            items=[{'item_id': 'entity-1', 'item_kind': 'entity'}],
        ),
    )

    query, parameters = driver.calls[0]
    assert "THEN 'reviewed' ELSE 'viewed'" in query
    assert "action: 'agent_view'" in query
    assert parameters['tool_name'] == 'search_knowledge_graph'
    assert result.recorded_count == 1
    assert result.item_keys == ['entity:entity-1']


@pytest.mark.asyncio
async def test_clean_agent_review_clears_only_the_current_human_change_version():
    reviewed_at = datetime(2026, 7, 28, 8, 0, tzinfo=timezone.utc)
    driver = SequentialDriver([
        [{
            'human_edited': True,
            'human_change_version': 4,
            'human_change_status': 'viewed',
        }],
        [{'audit': {
            'id': 'audit-review-1',
            'item_id': 'entity-1',
            'item_kind': 'entity',
            'action': 'agent_review',
            'human_change_version': 4,
            'reason': '未发现冲突，象限与依据一致。',
            'conflict_check': 'no_conflict',
            'classification_check': 'reasonable',
            'outcome': 'reviewed',
            'created_at': reviewed_at,
        }}],
    ])
    store = StoreStub(driver)

    result = await review_human_change(
        store,
        {'id': 'principal-1'},
        'entity-1',
        KnowledgeAgentReviewCreate(
            personal_space_id='personal-space',
            item_kind='entity',
            human_change_version=4,
            conflict_check='no_conflict',
            classification_check='reasonable',
            note='未发现冲突，象限与依据一致。',
        ),
    )

    query, parameters = driver.calls[1]
    assert 'item.fuli_human_change_version = $human_change_version' in query
    assert parameters['next_status'] == 'reviewed'
    assert result.outcome == 'reviewed'


@pytest.mark.asyncio
async def test_stale_agent_review_cannot_clear_a_newer_human_change():
    driver = SequentialDriver([[
        {
            'human_edited': True,
            'human_change_version': 5,
            'human_change_status': 'unseen',
        }
    ]])
    store = StoreStub(driver)

    with pytest.raises(HTTPException, match='version is stale'):
        await review_human_change(
            store,
            {'id': 'principal-1'},
            'entity-1',
            KnowledgeAgentReviewCreate(
                personal_space_id='personal-space',
                item_kind='entity',
                human_change_version=4,
                conflict_check='no_conflict',
                classification_check='reasonable',
                note='旧版本审核结果',
            ),
        )

    assert len(driver.calls) == 1


@pytest.mark.asyncio
async def test_human_change_search_keeps_reviewed_history_discoverable():
    changed_at = datetime(2026, 7, 28, 7, 0, tzinfo=timezone.utc)
    reviewed_at = datetime(2026, 7, 28, 8, 0, tzinfo=timezone.utc)
    driver = SequentialDriver([
        [{
            'item_id': 'entity-1',
            'title': '人工修订的规则',
            'body': '已经完成 Agent 审核。',
            'type': 'Decision',
            'human_change_status': 'reviewed',
            'human_change_version': 2,
            'last_human_changed_at': changed_at,
            'last_agent_viewed_at': reviewed_at,
            'last_agent_reviewed_at': reviewed_at,
        }],
        [],
        [{'audit': {
            'id': 'audit-review-1',
            'item_id': 'entity-1',
            'item_kind': 'entity',
            'action': 'agent_review',
            'human_change_version': 2,
            'reason': '审核完成',
            'outcome': 'reviewed',
            'created_at': reviewed_at,
        }}],
    ])
    store = StoreStub(driver)

    result = await search_human_changes(
        store,
        {'id': 'principal-1'},
        KnowledgeHumanChangeSearchRequest(
            personal_space_id='personal-space',
            query='规则',
            status='reviewed',
        ),
    )

    assert result.items[0].human_change_status == 'reviewed'
    assert result.items[0].audit_events[0].action == 'agent_review'
    assert driver.calls[0][1]['status'] == 'reviewed'
    assert driver.calls[0][1]['search_query'] == '规则'


def personal_space():
    return {
        'id': 'personal-space',
        'kind': 'personal',
        'group_id': 'personal-group',
    }


class SequentialDriver:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return next(self.responses), None, None


class RuntimeStub:
    def __init__(self, driver):
        self.driver = driver


class SettingsStub:
    provider_mode = 'personal'


class StoreStub:
    def __init__(self, driver):
        self.runtime = RuntimeStub(driver)
        self.settings = SettingsStub()

    def _require_personal(self):
        return None

    async def authorize(self, actor, space_id, required_role):
        return personal_space()
