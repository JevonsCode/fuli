from datetime import datetime, timezone

import pytest

from fuli_graph.common_knowledge import (
    apply_common_knowledge_promotion,
    preview_common_knowledge_promotion,
)
from fuli_graph.common_knowledge_models import CommonKnowledgePromotionRequest


@pytest.mark.asyncio
async def test_preview_is_read_only_and_requires_distinct_direct_children():
    driver = SequentialDriver([
        [{'project': {'project_id': 'platform-a'}}],
        [{'child_project_id': 'hotel-b'}, {'child_project_id': 'flight-c'}],
        [active_entity('Canonical retry rule')],
        [assignment('canonical', 'hotel-b')],
        [active_entity('Duplicate retry rule')],
        [assignment('duplicate', 'flight-c')],
    ])
    store = StoreStub(driver)

    result = await preview_common_knowledge_promotion(
        store,
        {'id': 'principal-1'},
        CommonKnowledgePromotionRequest(
            personal_space_id='personal-1',
            parent_project_id='platform-a',
            item_kind='entity',
            canonical_item_id='canonical',
            duplicate_item_ids=['duplicate'],
            reason='The retry runbook is shared by two direct children.',
            human_confirmation_reason='The user explicitly approved this scope change.',
        ),
    )

    assert result.status == 'ready'
    assert result.atomic is True
    assert result.source_project_ids == ['flight-c', 'hotel-b']
    assert all(
        'CREATE (promotion:FuliCommonKnowledgePromotion' not in query
        for query, _ in driver.calls
    )


@pytest.mark.asyncio
async def test_apply_promotes_and_invalidates_duplicates_in_one_mutation_query():
    changed_at = datetime(2026, 7, 31, 9, 0, tzinfo=timezone.utc)
    driver = SequentialDriver([
        [{'project': {'project_id': 'platform-a'}}],
        [{'child_project_id': 'hotel-b'}, {'child_project_id': 'flight-c'}],
        [active_entity('Canonical retry rule')],
        [assignment('canonical', 'hotel-b')],
        [active_entity('Duplicate retry rule')],
        [assignment('duplicate', 'flight-c')],
        [{
            'promotion_id': 'promotion-1',
            'assignment_id': 'assignment-canonical',
            'revision_ids': ['revision-canonical', 'revision-duplicate'],
        }],
    ])
    store = StoreStub(driver)
    request = CommonKnowledgePromotionRequest(
        personal_space_id='personal-1',
        parent_project_id='platform-a',
        item_kind='entity',
        canonical_item_id='canonical',
        duplicate_item_ids=['duplicate'],
        reason='The retry runbook is shared by two direct children.',
        human_confirmation_reason='The user explicitly approved this scope change.',
    )

    result = await apply_common_knowledge_promotion(
        store,
        {'id': 'principal-1'},
        request,
        changed_at=changed_at,
    )

    mutation_query, parameters = driver.calls[-1]
    assert 'CREATE (promotion:FuliCommonKnowledgePromotion' in mutation_query
    assert "canonical.fuli_inheritance_mode = 'descendants'" in mutation_query
    assert 'pair.item.fuli_invalid_at = $changed_at' in mutation_query
    assert 'CREATE (revision:FuliKnowledgeRevision' in mutation_query
    assert (
        'canonical_assignment.project_id = $canonical_source_project_id'
        in mutation_query
    )
    assert (
        'duplicate_assignment.project_id = duplicate_spec.project_id'
        in mutation_query
    )
    assert 'canonical_episode.fuli_personal_project_id' in mutation_query
    assert 'duplicate_episode.fuli_personal_project_id' in mutation_query
    assert parameters['reason'] == request.reason
    assert parameters['human_confirmation_reason'] == request.human_confirmation_reason
    assert len([
        query for query, _ in driver.calls
        if 'CREATE (promotion:FuliCommonKnowledgePromotion' in query
    ]) == 1
    assert result.status == 'promoted'
    assert result.promotion_id == 'promotion-1'
    assert result.invalidated_item_ids == ['duplicate']
    assert result.inheritance_mode == 'descendants'


def active_entity(name):
    return {
        'name': name,
        'type': 'ProjectKnowledge',
        'summary': 'Synthetic retry fixture.',
        'invalid_at': None,
        'classification_state_explicit': True,
        'origin_quadrant': 'known_known',
        'current_quadrant': 'known_known',
        'epistemic_status': 'confirmed',
        'confirmation_status': 'confirmed',
        'confirmation_state_explicit': True,
        'confirmation_basis_json': None,
        'reasoning_summary': None,
        'profile_aspect': None,
        'preference_scope': None,
        'preference_project_id': None,
        'inheritance_mode': 'local_only',
        'inherited_project_ids': [],
        'utility_score': 0.5,
        'confidence_score': 0.8,
        'qualified_use_count': 2,
        'distinct_task_count': 2,
        'last_used_at': None,
        'usage_generation': 1,
        'replaced_by_item_id': None,
        'replaced_by_item_kind': None,
    }


def assignment(item_id, project_id):
    now = datetime(2026, 7, 30, tzinfo=timezone.utc)
    return {'assignment': {
        'id': f'assignment-{item_id}',
        'item_id': item_id,
        'item_kind': 'entity',
        'project_id': project_id,
        'previous_project_id': None,
        'reason': 'Synthetic fixture assignment.',
        'created_at': now,
        'updated_at': now,
    }}


class SequentialDriver:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return next(self.responses), None, None


class SettingsStub:
    provider_mode = 'personal'


class RuntimeStub:
    def __init__(self, driver):
        self.driver = driver


class StoreStub:
    def __init__(self, driver):
        self.runtime = RuntimeStub(driver)
        self.settings = SettingsStub()

    def _require_personal(self):
        return None

    async def authorize(self, actor, space_id, required_role):
        return {
            'id': space_id,
            'kind': 'personal',
            'group_id': 'personal-group',
        }
