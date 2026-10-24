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
from sequential_driver_support import SequentialDriver

# The person's console, with the human-review proof: it sees every FLA's items.
PERSON = {'id': 'principal-1', '_human_review_verified': True}


@pytest.mark.asyncio
@pytest.mark.parametrize('extra', [0, 1])
async def test_active_conflict_queue_keeps_multiple_ids_and_probes_one_extra(extra):
    from fuli_graph.preference_conflicts import read_active_preference_conflicts
    pending = [{**conflict_record(), 'id': f'pending-{i}'} for i in range(2 + extra)]
    driver = SequentialDriver([[{'conflict': item} for item in pending]])
    store = StoreStub(driver)
    alternatives = [SimpleNamespace(id=item, item_kind='entity', preference_key='dashboard.layout',
                                    preference_scope='global') for item in ['left', 'right']]
    conflicts = [SimpleNamespace(item_ids=['left', 'right'], preference_key='dashboard.layout', preference_scope='global')]
    records, truncated = await read_active_preference_conflicts(store, 'personal-space', conflicts, alternatives, limit=2)
    assert [item.id for item in records] == ['pending-0', 'pending-1']
    assert truncated is bool(extra)
    query, parameters = driver.calls[0]
    assert parameters['limit'] == 3
    assert parameters['active_groups'] == [[{'id': 'left', 'kind': 'entity'}, {'id': 'right', 'kind': 'entity'}]]
    for field in ['personal_space_id', 'left_item_id', 'left_item_kind', 'right_item_id', 'right_item_kind']:
        assert f'conflict.{field}' in query


@pytest.mark.asyncio
async def test_no_active_conflict_pairs_do_not_read_the_queue():
    from fuli_graph.preference_conflicts import read_active_preference_conflicts
    driver = SequentialDriver([])
    assert await read_active_preference_conflicts(StoreStub(driver), 'personal-space', [], [], limit=100) == ([], False)
    assert driver.calls == []


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
        PERSON,
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
    assert 'fuli_ai_review_lock_version' in defer_query
    assert 'ORDER BY lock_item.kind + \':\' + lock_item.item.uuid' in defer_query
    assert "$left_item_kind + ':' + left.uuid" in defer_query
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
        [],  # neither side is another FLA's item
        [entity_item('left')],
        [entity_item('right')],
        [entity_item('right')],
        [entity_item('left')],
        [],  # no revisions: a deactivation of a version that never ended
        [{'item_id': 'right'}],  # the compare-and-set write matched
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
    assert 'fla_episode' in driver.calls[1][0] and driver.calls[1][1]['item_ids'] == ['left', 'right']
    assert 'FuliKnowledgeRevision' in driver.calls[6][0], 'a version that never ended may be deactivated'
    update_query, update_parameters = driver.calls[7]
    assert 'fuli_invalid_at' in update_query
    assert update_parameters['item_id'] == 'right'
    assert update_parameters['replaced_by_item_id'] == 'left'
    complete_query, complete_parameters = driver.calls[-1]
    assert "conflict.status = 'resolved'" in complete_query
    assert 'ORDER BY lock_item.kind + \':\' + lock_item.item.uuid' in complete_query
    assert "$left_item_kind + ':' + left.uuid" in complete_query
    assert complete_parameters['left_item_id'] == 'left'
    assert complete_parameters['right_item_id'] == 'right'
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
        PERSON,
        pending['id'],
        PreferenceConflictCompleteCreate(
            personal_space_id='personal-space',
            resolution='merge',
            reason='用户在工作台中完成合并。',
            operation_actor='human',
        ),
    )

    assert result.resolved_by == 'human'


@pytest.mark.asyncio
@pytest.mark.parametrize('status', ['ai_pending', 'resolved'])
async def test_a_conflict_naming_another_flas_item_is_missing_to_an_agent_and_nothing_is_written(status):
    """0.20.1: resolve (its resolved retry too), complete and defer check both
    items before any write or return; the Cypher is in test_fla_entry_points_neo4j.py."""
    from fastapi import HTTPException
    hidden = [{'id': 'left'}]
    agent = {'id': 'principal-1'}
    stored = {**conflict_record(), 'status': status}
    calls = {
        'resolve': ([[{'conflict': stored}], hidden], lambda store: resolve_preference_conflict(
            store, agent, stored['id'], PreferenceConflictResolveCreate(
                personal_space_id='personal-space', resolution='keep_left', reason='Synthetic.'))),
        'complete': ([[{'conflict': stored}], hidden], lambda store: complete_preference_conflict(
            store, agent, stored['id'], PreferenceConflictCompleteCreate(
                personal_space_id='personal-space', resolution='merge', reason='Synthetic.'))),
        'defer': ([[{'conflict': stored}], hidden], lambda store: defer_preference_conflict(
            store, agent, PreferenceConflictDeferCreate(
                personal_space_id='personal-space', conflict_id=stored['id'], preference_key='dashboard.layout',
                preference_scope='global', left_item_id='left', left_item_kind='entity', right_item_id='right',
                right_item_kind='entity', reason='Synthetic.', operation_actor='agent'))),
    }
    for name, (replies, call) in calls.items():
        driver = SequentialDriver(replies)
        with pytest.raises(HTTPException) as refused:
            await call(StoreStub(driver))
        assert (refused.value.status_code, refused.value.detail) == (404, 'preference conflict not found'), name
        assert len(driver.calls) == 2, f'{name} wrote or returned nothing after the check'


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
