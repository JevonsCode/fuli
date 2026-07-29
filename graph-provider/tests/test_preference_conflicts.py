from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from fuli_graph.models import (
    PreferenceConflictCompleteCreate,
    PreferenceConflictDeferCreate,
    PreferenceConflictResolveCreate,
)
from fuli_graph.preference_conflicts import (
    complete_preference_conflict,
    defer_preference_conflict,
    resolve_preference_conflict,
)


@pytest.mark.asyncio
async def test_human_can_defer_one_exact_preference_pair_until_ai_needs_it():
    driver = SequentialDriver([
        [entity_item('left')],
        [entity_item('right')],
        [{'conflict': conflict_record()}],
    ])
    store = StoreStub(driver)

    result = await defer_preference_conflict(
        store,
        {'id': 'principal-1'},
        PreferenceConflictDeferCreate(
            personal_space_id='personal-space',
            conflict_id='entity:left:entity:right',
            preference_key='dashboard.layout',
            preference_scope='global',
            left_item_id='left',
            left_item_kind='entity',
            right_item_id='right',
            right_item_kind='entity',
            reason='用户选择在首次相关使用前交给 AI 判断。',
            operation_actor='human',
        ),
    )

    assert result.status == 'ai_pending'
    assert result.requested_by == 'human'
    defer_query, parameters = driver.calls[-1]
    assert 'FuliPreferenceConflict' in defer_query
    assert parameters['left_item_id'] == 'left'
    assert parameters['right_item_id'] == 'right'
    assert parameters['requested_by'] == 'human'


@pytest.mark.asyncio
async def test_ai_keep_left_invalidates_right_and_marks_the_resolution():
    pending = conflict_record()
    resolved = {
        **pending,
        'status': 'resolved',
        'resolution': 'keep_left',
        'resolved_by': 'agent',
        'resolution_reason': '当前任务中较早规则仍与证据一致。',
        'resolved_at': datetime(2026, 7, 29, 2, 0, tzinfo=UTC),
        'updated_at': datetime(2026, 7, 29, 2, 0, tzinfo=UTC),
    }
    driver = SequentialDriver([
        [{'conflict': pending}],
        [entity_item('left')],
        [entity_item('right')],
        [entity_item('right')],
        [entity_item('left')],
        [],
        [],
        [{'conflict': resolved}],
    ])
    store = StoreStub(driver)

    result = await resolve_preference_conflict(
        store,
        {'id': 'principal-1'},
        pending['id'],
        PreferenceConflictResolveCreate(
            personal_space_id='personal-space',
            resolution='keep_left',
            reason='当前任务中较早规则仍与证据一致。',
            operation_actor='agent',
        ),
    )

    assert result.status == 'resolved'
    assert result.resolved_by == 'agent'
    update_query, update_parameters = driver.calls[5]
    assert 'fuli_invalid_at' in update_query
    assert update_parameters['item_id'] == 'right'
    assert update_parameters['replaced_by_item_id'] == 'left'
    complete_query, complete_parameters = driver.calls[-1]
    assert "conflict.status = 'resolved'" in complete_query
    assert complete_parameters['resolved_by'] == 'agent'


@pytest.mark.asyncio
async def test_manual_resolution_closes_a_deferred_marker_without_claiming_ai_authorship():
    pending = conflict_record()
    resolved = {
        **pending,
        'status': 'resolved',
        'resolution': 'merge',
        'resolved_by': 'human',
        'resolution_reason': '用户在工作台中完成合并。',
        'resolved_at': datetime(2026, 7, 29, 2, 0, tzinfo=UTC),
        'updated_at': datetime(2026, 7, 29, 2, 0, tzinfo=UTC),
    }
    driver = SequentialDriver([
        [{'conflict': pending}],
        [{'conflict': resolved}],
    ])
    store = StoreStub(driver)

    result = await complete_preference_conflict(
        store,
        {'id': 'principal-1'},
        pending['id'],
        PreferenceConflictCompleteCreate(
            personal_space_id='personal-space',
            resolution='merge',
            reason='用户在工作台中完成合并。',
            operation_actor='human',
        ),
    )

    assert result.resolved_by == 'human'


def test_ai_merge_requires_a_canonical_item_and_merged_instruction():
    with pytest.raises(ValidationError, match='merge requires'):
        PreferenceConflictResolveCreate(
            personal_space_id='personal-space',
            resolution='merge',
            reason='需要合并。',
        )


class StoreStub:
    def __init__(self, driver):
        self.runtime = SimpleNamespace(driver=driver)
        self.settings = SimpleNamespace(provider_mode='personal')

    def _require_personal(self):
        return None

    async def authorize(self, actor, space_id, role):
        assert actor['id'] == 'principal-1'
        assert space_id == 'personal-space'
        assert role in {'reader', 'maintainer'}
        return {
            'id': 'personal-space',
            'kind': 'personal',
            'group_id': 'personal-group',
        }


class SequentialDriver:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return self.responses.pop(0), None, None


def entity_item(item_id):
    return {
        'name': f'Preference {item_id}',
        'summary': f'Instruction {item_id}',
        'invalid_at': None,
        'classification_state_explicit': True,
        'origin_quadrant': 'known_known',
        'current_quadrant': 'known_known',
        'epistemic_status': 'confirmed',
        'confirmation_status': 'confirmed',
        'confirmation_state_explicit': True,
        'confirmation_basis_json': None,
        'reasoning_summary': None,
        'profile_aspect': 'taste',
        'preference_scope': 'global',
        'preference_project_id': None,
        'replaced_by_item_id': None,
        'replaced_by_item_kind': None,
    }


def conflict_record():
    deferred_at = datetime(2026, 7, 29, 1, 0, tzinfo=UTC)
    return {
        'id': 'entity:left:entity:right',
        'personal_space_id': 'personal-space',
        'preference_key': 'dashboard.layout',
        'preference_scope': 'global',
        'preference_project_id': None,
        'left_item_id': 'left',
        'left_item_kind': 'entity',
        'right_item_id': 'right',
        'right_item_kind': 'entity',
        'status': 'ai_pending',
        'requested_by': 'human',
        'resolution': None,
        'resolved_by': None,
        'reason': '用户选择在首次相关使用前交给 AI 判断。',
        'resolution_reason': None,
        'deferred_at': deferred_at,
        'resolved_at': None,
        'updated_at': deferred_at,
    }
