import json
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from fuli_graph.knowledge_audit import (
    record_agent_views,
    record_human_change,
    record_knowledge_feedback,
    record_knowledge_usage,
    review_human_change,
    search_human_changes,
)
from fuli_graph.knowledge_usage_models import KnowledgeUsageCreate
from fuli_graph.knowledge_feedback_models import KnowledgeFeedbackCreate
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


@pytest.mark.asyncio
async def test_five_material_uses_across_three_tasks_promote_only_to_agent_confirmed():
    used_at = datetime(2026, 7, 29, 8, 0, tzinfo=timezone.utc)
    driver = SequentialDriver([
        [{
            'confirmation_status': 'pending',
            'confirmation_basis_json': json.dumps({
                'existence_reason': 'Captured from a project discussion.',
                'quadrant_reason': 'The user explicitly described the rule.',
                'proposed_by': {'kind': 'agent', 'label': 'Codex'},
            }),
            'usage_generation': 2,
            'invalid_at': None,
            'has_open_conflict': False,
        }],
        [{'recorded': True}],
        [{
            'qualified_use_count': 5,
            'distinct_task_count': 3,
            'applied_count': 2,
            'cited_count': 3,
            'last_used_at': used_at,
        }],
        [{'confirmation_status': 'agent_confirmed'}],
    ])
    store = StoreStub(driver)

    result = await record_knowledge_usage(
        store,
        {'id': 'principal-1'},
        KnowledgeUsageCreate(
            personal_space_id='personal-space',
            task_id='task-5',
            session_id='session-3',
            tool_name='record_knowledge_usage',
            items=[{
                'item_id': 'entity-1',
                'item_kind': 'entity',
                'use_kind': 'applied',
            }],
        ),
    )

    state_query, _ = driver.calls[0]
    _, usage_parameters = driver.calls[1]
    _, update_parameters = driver.calls[3]
    basis = json.loads(update_parameters['confirmation_basis_json'])
    assert 'HAS_KNOWLEDGE_CONFLICT' in state_query
    assert 'HAS_PREFERENCE_CONFLICT' in state_query
    assert usage_parameters['usage_generation'] == 2
    assert result.recorded_count == 1
    assert result.promoted_count == 1
    assert result.items[0].confirmation_status == 'agent_confirmed'
    assert result.items[0].utility_score == 0.72
    assert result.items[0].confidence_score == 0.74
    assert basis['confirmed_by']['kind'] == 'agent'
    assert basis['agent_policy_version'] == 'agent-usage-v1'


@pytest.mark.asyncio
async def test_open_conflict_blocks_agent_promotion_even_after_the_usage_threshold():
    driver = SequentialDriver([
        [{
            'confirmation_status': 'pending',
            'confirmation_basis_json': None,
            'usage_generation': 1,
            'invalid_at': None,
            'has_open_conflict': True,
        }],
        [{'recorded': True}],
        [{
            'qualified_use_count': 8,
            'distinct_task_count': 6,
            'applied_count': 4,
            'cited_count': 4,
            'last_used_at': datetime(2026, 7, 29, 8, 0, tzinfo=timezone.utc),
        }],
        [{'confirmation_status': 'pending'}],
    ])
    store = StoreStub(driver)

    result = await record_knowledge_usage(
        store,
        {'id': 'principal-1'},
        KnowledgeUsageCreate(
            personal_space_id='personal-space',
            task_id='task-8',
            items=[{
                'item_id': 'entity-1',
                'item_kind': 'entity',
                'use_kind': 'cited',
            }],
        ),
    )

    assert result.promoted_count == 0
    assert result.items[0].confirmation_status == 'pending'
    assert driver.calls[3][1]['promoted'] is False


@pytest.mark.asyncio
async def test_negative_evidence_flags_human_confirmed_knowledge_without_overriding_authority():
    driver = SequentialDriver([
        [{
            'confirmation_status': 'confirmed',
            'confirmation_basis_json': json.dumps({
                'existence_reason': 'The user confirmed the runbook.',
                'quadrant_reason': 'It was explicitly stated.',
                'proposed_by': {'kind': 'user'},
                'confirmed_by': {'kind': 'user'},
                'confirmed_at': '2026-07-30T08:00:00Z',
            }),
            'usage_generation': 2,
            'invalid_at': None,
            'utility_score': 0.8,
            'confidence_score': 1.0,
            'negative_evidence_count': 0,
        }],
        [{
            'recorded': True,
            'confirmation_status': 'confirmed',
            'utility_score': 0.45,
            'confidence_score': 0.7,
            'negative_evidence_count': 1,
            'requires_attention': True,
        }],
    ])
    store = StoreStub(driver)

    result = await record_knowledge_feedback(
        store,
        {'id': 'principal-1'},
        KnowledgeFeedbackCreate(
            personal_space_id='personal-space',
            task_id='task-negative-1',
            items=[{
                'item_id': 'entity-1',
                'item_kind': 'entity',
                'feedback_kind': 'validation_failed',
                'reason': 'The local validation command failed.',
                'evidence_summary': 'Synthetic fixture: exit code 1.',
                'reported_by_kind': 'agent',
            }],
        ),
    )

    query, parameters = driver.calls[1]
    assert "action = 'knowledge_feedback'" in query
    assert 'item.fuli_requires_attention = true' in query
    assert parameters['next_confirmation_status'] == 'confirmed'
    assert result.items[0].confirmation_status == 'confirmed'
    assert result.items[0].requires_attention is True
    assert result.items[0].negative_evidence_count == 1


@pytest.mark.asyncio
async def test_human_contradiction_demotes_only_agent_confirmed_knowledge_to_pending():
    driver = SequentialDriver([
        [{
            'confirmation_status': 'agent_confirmed',
            'confirmation_basis_json': json.dumps({
                'existence_reason': 'Retained from an Agent proposal.',
                'quadrant_reason': 'Observed in earlier tasks.',
                'proposed_by': {'kind': 'agent'},
                'confirmed_by': {'kind': 'agent'},
                'confirmed_at': '2026-07-30T08:00:00Z',
                'agent_policy_version': 'agent-usage-v1',
            }),
            'usage_generation': 3,
            'invalid_at': None,
            'utility_score': 0.7,
            'confidence_score': 0.8,
            'negative_evidence_count': 0,
        }],
        [{
            'recorded': True,
            'confirmation_status': 'pending',
            'utility_score': 0.25,
            'confidence_score': 0.4,
            'negative_evidence_count': 1,
            'requires_attention': True,
        }],
    ])
    store = StoreStub(driver)

    result = await record_knowledge_feedback(
        store,
        {'id': 'principal-1'},
        KnowledgeFeedbackCreate(
            personal_space_id='personal-space',
            task_id='task-negative-2',
            items=[{
                'item_id': 'entity-2',
                'item_kind': 'entity',
                'feedback_kind': 'contradicted',
                'reason': 'The user corrected the stored behavior.',
                'evidence_summary': 'Synthetic fixture: expected output differs.',
                'reported_by_kind': 'user',
            }],
        ),
    )

    assert driver.calls[1][1]['next_confirmation_status'] == 'pending'
    pending_basis = json.loads(
        driver.calls[1][1]['next_confirmation_basis_json']
    )
    assert pending_basis['confirmed_by'] is None
    assert pending_basis['confirmed_at'] is None
    assert 'agent_policy_version' not in pending_basis
    assert result.items[0].confirmation_status == 'pending'


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
        self._group_locks = {}

    def _require_personal(self):
        return None

    async def authorize(self, actor, space_id, required_role):
        return personal_space()
