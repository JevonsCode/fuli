from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from fuli_graph.knowledge_batch_confirmation import confirm_knowledge_batch
from fuli_graph.knowledge_management import (
    reassign_knowledge_item,
    revise_knowledge_item,
    set_preference_scope,
)
from fuli_graph.models import (
    KnowledgeAssignmentChange,
    KnowledgeBatchConfirmationCreate,
    KnowledgeRevisionCreate,
    PreferenceScopeChange,
)
from fuli_graph.models import (
    KnowledgeProjectActionRequest,
    KnowledgeProjectPreviewRequest,
)
from fuli_graph.project_knowledge import (
    _relation_endpoints,
    apply_knowledge_project_action,
    preview_knowledge_project_action,
)


@pytest.mark.asyncio
async def test_entity_correction_preserves_a_revision_record_before_updating_current_value():
    driver = SequentialDriver([
        [{'name': 'Old name', 'summary': 'Old summary', 'invalid_at': None}],
        [],
        [],
    ])
    store = StoreStub(driver)
    request = KnowledgeRevisionCreate(
        personal_space_id='personal-space',
        item_kind='entity',
        action='update',
        reason='名称沉淀错误',
        name='Correct name',
        summary='Correct summary',
    )

    result = await revise_knowledge_item(
        store, {'id': 'principal-1'}, 'entity-1', request
    )

    update_query, update_parameters = driver.calls[1]
    history_query, history_parameters = driver.calls[2]
    assert 'SET item.name = $name' in update_query
    assert update_parameters['name'] == 'Correct name'
    assert update_parameters['confirmation_status'] == 'pending'
    assert '名称沉淀错误' in update_parameters['confirmation_basis_json']
    assert 'FuliKnowledgeRevision' in history_query
    assert history_parameters['previous_json'].find('Old name') > 0
    assert result.current['summary'] == 'Correct summary'


@pytest.mark.asyncio
async def test_human_entity_correction_starts_an_unseen_agent_review_marker():
    driver = SequentialDriver([
        [{'name': 'Old name', 'summary': 'Old summary', 'invalid_at': None}],
        [],
        [],
        [{'human_change_version': 1}],
    ])
    store = StoreStub(driver)

    await revise_knowledge_item(
        store,
        {'id': 'principal-1'},
        'entity-1',
        KnowledgeRevisionCreate(
            personal_space_id='personal-space',
            item_kind='entity',
            action='update',
            reason='人工修正摘要',
            summary='Correct summary',
            operation_actor='human',
        ),
    )

    audit_query, parameters = driver.calls[-1]
    assert "item.fuli_human_change_status = 'unseen'" in audit_query
    assert parameters['operation'] == 'knowledge_update'


@pytest.mark.asyncio
async def test_single_confirmation_records_server_time_without_changing_content():
    driver = SequentialDriver([
        [{
            'name': 'Design preference',
            'summary': 'Use a clean selected state.',
            'invalid_at': None,
            'classification_state_explicit': True,
            'origin_quadrant': 'known_known',
            'current_quadrant': 'known_known',
            'epistemic_status': 'observed',
            'confirmation_status': 'pending',
            'confirmation_state_explicit': False,
        }],
        [],
        [],
    ])
    store = StoreStub(driver)
    request = KnowledgeRevisionCreate(
        personal_space_id='personal-space',
        item_kind='entity',
        action='confirm',
        reason='Reviewed the content and discovery quadrant.',
        confirmation_status='confirmed',
        confirmation_basis={
            'existence_reason': 'The user explicitly stated this preference.',
            'quadrant_reason': 'It was explicitly expressed.',
            'proposed_by': {'kind': 'agent', 'label': 'Codex'},
            'confirmed_by': {'kind': 'user', 'label': 'Current user'},
            'confirmed_at': datetime(2020, 1, 1, tzinfo=timezone.utc),
        },
    )

    result = await revise_knowledge_item(
        store, {'id': 'principal-1'}, 'entity-1', request
    )

    _, update_parameters = driver.calls[1]
    _, history_parameters = driver.calls[2]
    assert update_parameters['name'] == 'Design preference'
    assert update_parameters['confirmation_status'] == 'confirmed'
    assert '"confirmed_by"' in update_parameters['confirmation_basis_json']
    assert result.action == 'confirm'
    assert result.current['confirmationBasis']['confirmed_at'] != (
        '2020-01-01T00:00:00Z'
    )
    assert history_parameters['action'] == 'confirm'


@pytest.mark.asyncio
async def test_single_confirmation_requires_an_explicit_discovery_quadrant():
    driver = SequentialDriver([[
        {
            'name': 'Legacy preference',
            'summary': 'No explicit quadrant.',
            'invalid_at': None,
            'classification_state_explicit': False,
            'confirmation_status': 'pending',
            'confirmation_state_explicit': False,
        }
    ]])
    store = StoreStub(driver)
    request = KnowledgeRevisionCreate(
        personal_space_id='personal-space',
        item_kind='entity',
        action='confirm',
        reason='Reviewed.',
        confirmation_status='confirmed',
        confirmation_basis={
            'existence_reason': 'Imported legacy record.',
            'quadrant_reason': 'Not yet classified.',
            'proposed_by': {'kind': 'import', 'label': 'Legacy import'},
            'confirmed_by': {'kind': 'user', 'label': 'Current user'},
            'confirmed_at': datetime.now(timezone.utc),
        },
    )

    with pytest.raises(HTTPException, match='explicit discovery quadrant'):
        await revise_knowledge_item(
            store, {'id': 'principal-1'}, 'entity-1', request
        )

    assert len(driver.calls) == 1


@pytest.mark.asyncio
async def test_historical_knowledge_can_link_to_a_current_replacement_with_audit_history():
    invalid_at = datetime(2026, 7, 23, tzinfo=timezone.utc)
    driver = SequentialDriver([
        [{
            'name': 'Old requirement',
            'summary': 'An outdated requirement.',
            'invalid_at': invalid_at,
        }],
        [{
            'name': 'Current requirement',
            'summary': 'The reviewed replacement.',
            'invalid_at': None,
        }],
        [],
        [],
    ])
    store = StoreStub(driver)
    request = KnowledgeRevisionCreate(
        personal_space_id='personal-space',
        item_kind='entity',
        action='link_replacement',
        reason='The newer reviewed requirement supersedes this record.',
        replacement_item_id='entity-current',
        replacement_item_kind='entity',
    )

    result = await revise_knowledge_item(
        store, {'id': 'principal-1'}, 'entity-old', request
    )

    update_query, update_parameters = driver.calls[2]
    _, history_parameters = driver.calls[3]
    assert 'fuli_replaced_by_item_id' in update_query
    assert update_parameters['replaced_by_item_id'] == 'entity-current'
    assert update_parameters['replaced_by_item_kind'] == 'entity'
    assert update_parameters['invalid_at'] == invalid_at
    assert result.current['replacedByItemId'] == 'entity-current'
    assert result.current['invalidAt'] == invalid_at.isoformat()
    assert history_parameters['action'] == 'link_replacement'


@pytest.mark.asyncio
async def test_batch_confirmation_updates_one_source_group_with_individual_revision_history():
    driver = SequentialDriver([
        [{
            'name': 'Decision',
            'summary': 'Keep the original content.',
            'invalid_at': None,
            'origin_quadrant': 'known_known',
            'current_quadrant': 'known_known',
            'epistemic_status': 'observed',
            'confirmation_status': 'pending',
            'confirmation_state_explicit': False,
        }],
        [{
            'type': 'SUPPORTS',
            'fact': 'The source supports the decision.',
            'invalid_at': None,
            'origin_quadrant': 'known_known',
            'current_quadrant': 'known_known',
            'epistemic_status': 'observed',
            'confirmation_status': 'pending',
            'confirmation_state_explicit': False,
        }],
        [{'confirmed_count': 2}],
    ])
    store = StoreStub(driver)
    request = KnowledgeBatchConfirmationCreate(
        personal_space_id='personal-space',
        group_kind='source',
        group_value='episode-1',
        reason='Reviewed every item from this source.',
        confirmer={'kind': 'user', 'label': 'Current user'},
        items=[
            {
                'item_id': 'entity-1',
                'item_kind': 'entity',
                'existence_reason': 'The source records this decision.',
                'quadrant_reason': 'It was explicitly stated.',
                'proposed_by': {'kind': 'agent', 'label': 'Codex'},
            },
            {
                'item_id': 'relationship-1',
                'item_kind': 'relationship',
                'existence_reason': 'The source records this relationship.',
                'quadrant_reason': 'It was explicitly stated.',
                'proposed_by': {'kind': 'agent', 'label': 'Codex'},
            },
        ],
    )

    result = await confirm_knowledge_batch(
        store,
        {'id': 'principal-1'},
        request,
    )

    query, parameters = driver.calls[-1]
    assert 'valid_count = size(items)' in query
    assert "action: 'batch_confirm'" in query
    assert parameters['group_kind'] == 'source'
    assert parameters['group_value'] == 'episode-1'
    assert all('"confirmed_by"' in row['confirmation_basis_json']
               for row in parameters['items'])
    assert result.confirmed_count == 2
    assert result.item_keys == ['entity:entity-1', 'relationship:relationship-1']


@pytest.mark.asyncio
async def test_batch_confirmation_saves_nothing_when_the_source_group_changed():
    driver = SequentialDriver([
        [{
            'name': 'Decision',
            'summary': 'Keep the original content.',
            'invalid_at': None,
            'origin_quadrant': 'known_known',
            'current_quadrant': 'known_known',
            'epistemic_status': 'observed',
            'confirmation_status': 'pending',
            'confirmation_state_explicit': False,
        }],
        [{
            'name': 'Second decision',
            'summary': 'Keep the original content.',
            'invalid_at': None,
            'origin_quadrant': 'known_known',
            'current_quadrant': 'known_known',
            'epistemic_status': 'observed',
            'confirmation_status': 'pending',
            'confirmation_state_explicit': False,
        }],
        [],
    ])
    store = StoreStub(driver)
    request = KnowledgeBatchConfirmationCreate(
        personal_space_id='personal-space',
        group_kind='session',
        group_value='session-1',
        reason='Reviewed every item from this session.',
        confirmer={'kind': 'user'},
        items=[
            {
                'item_id': item_id,
                'item_kind': 'entity',
                'existence_reason': 'Captured from the session.',
                'quadrant_reason': 'Explicitly stated.',
                'proposed_by': {'kind': 'agent'},
            }
            for item_id in ['entity-1', 'entity-2']
        ],
    )

    with pytest.raises(HTTPException, match='refresh and review'):
        await confirm_knowledge_batch(store, {'id': 'principal-1'}, request)


@pytest.mark.asyncio
async def test_assignment_override_moves_one_item_without_rewriting_episode_evidence():
    changed_at = datetime(2026, 7, 22, tzinfo=timezone.utc)
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-b'}}],
        [{'name': 'Rule', 'summary': 'Keep this rule', 'invalid_at': None}],
        [],
        [{'project_ids': ['project-a']}],
        [{'assignment': {
            'id': 'assignment-1',
            'item_id': 'entity-1',
            'item_kind': 'entity',
            'project_id': 'project-b',
            'previous_project_id': 'project-a',
            'reason': '原项目归属错误',
            'created_at': changed_at,
            'updated_at': changed_at,
        }}],
    ])
    store = StoreStub(driver)

    result = await reassign_knowledge_item(
        store,
        {'id': 'principal-1'},
        'entity-1',
        KnowledgeAssignmentChange(
            personal_space_id='personal-space',
            item_kind='entity',
            target_project_id='project-b',
            reason='原项目归属错误',
        ),
    )

    assignment_query, parameters = driver.calls[-1]
    assert 'FuliKnowledgeAssignment' in assignment_query
    assert 'Episodic' not in assignment_query
    assert parameters['previous_project_id'] == 'project-a'
    assert result.project_id == 'project-b'


@pytest.mark.asyncio
async def test_personal_profile_knowledge_cannot_be_reassigned_to_a_project():
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-b'}}],
        [{
            'name': 'Restrained product design',
            'summary': 'The user prefers restrained interfaces.',
            'invalid_at': None,
            'profile_aspect': 'taste',
        }],
    ])
    store = StoreStub(driver)

    with pytest.raises(HTTPException, match='cannot be assigned to a project'):
        await reassign_knowledge_item(
            store,
            {'id': 'principal-1'},
            'entity-profile',
            KnowledgeAssignmentChange(
                personal_space_id='personal-space',
                item_kind='entity',
                target_project_id='project-b',
                reason='Attempted project move',
            ),
        )

    assert len(driver.calls) == 2


@pytest.mark.asyncio
async def test_personal_profile_scope_changes_to_one_project_with_revision_history():
    driver = SequentialDriver([
        [{'project': {'project_id': 'fuli'}}],
        [{
            'name': 'Restrained product design',
            'summary': 'The user prefers restrained interfaces.',
            'invalid_at': None,
            'profile_aspect': 'taste',
            'preference_scope': 'global',
            'preference_project_id': None,
        }],
        [],
        [],
    ])
    store = StoreStub(driver)

    result = await set_preference_scope(
        store,
        {'id': 'principal-1'},
        'entity-profile',
        PreferenceScopeChange(
            personal_space_id='personal-space',
            item_kind='entity',
            scope='project',
            project_id='fuli',
            reason='This preference applies only to Fuli.',
        ),
    )

    scope_query, scope_parameters = driver.calls[2]
    history_query, _ = driver.calls[3]
    assert 'fuli_preference_scope' in scope_query
    assert scope_parameters['project_id'] == 'fuli'
    assert 'FuliKnowledgeRevision' in history_query
    assert "action: 'scope_change'" in history_query
    assert result.action == 'scope_change'
    assert result.current['preferenceProjectId'] == 'fuli'


@pytest.mark.asyncio
async def test_project_action_preview_reuses_an_exact_duplicate_in_the_target_project():
    driver = SequentialDriver([
        [{
            'name': '酒店主题',
            'type': 'Feature',
            'summary': '酒店主题活动配置',
            'invalid_at': None,
            'current_quadrant': 'known_known',
            'epistemic_status': 'confirmed',
            'confirmation_status': 'confirmed',
        }],
        [{'project': {'project_id': 'project-a'}}],
        [],
        [{'project_ids': ['project-b']}],
        [],
        [{
            'id': 'target-entity',
            'name': '酒店主题',
            'summary': '酒店主题活动配置',
            'current_quadrant': 'known_known',
            'epistemic_status': 'confirmed',
            'confirmation_status': 'confirmed',
        }],
    ])
    store = StoreStub(driver)

    result = await preview_knowledge_project_action(
        store,
        {'id': 'principal-1'},
        'source-entity',
        KnowledgeProjectPreviewRequest(
            personal_space_id='personal-space',
            target_project_id='project-a',
        ),
    )

    assert result.source_project_id == 'project-b'
    assert result.match.kind == 'exact_duplicate'
    assert result.match.item_id == 'target-entity'


@pytest.mark.asyncio
async def test_cross_project_conflict_is_recorded_pending_without_changing_primary_owner():
    changed_at = datetime(2026, 7, 22, tzinfo=timezone.utc)
    assignment = {
        'id': 'assignment-source',
        'item_id': 'source-entity',
        'item_kind': 'entity',
        'project_id': 'project-b',
        'previous_project_id': None,
        'reason': '原始归属',
        'created_at': changed_at,
        'updated_at': changed_at,
    }
    driver = SequentialDriver([
        [{
            'name': '发布规则',
            'type': 'DevelopmentRule',
            'summary': '必须先审核再发布',
            'invalid_at': None,
            'current_quadrant': 'known_known',
            'epistemic_status': 'confirmed',
            'confirmation_status': 'confirmed',
        }],
        [{'assignment': assignment}],
        [{'project': {'project_id': 'project-a'}}],
        [],
        [{
            'id': 'target-entity',
            'name': '发布规则',
            'summary': '可以直接发布',
            'current_quadrant': 'known_known',
            'epistemic_status': 'confirmed',
            'confirmation_status': 'confirmed',
        }],
        [{'reference': {
            'id': 'reference-1',
            'item_id': 'source-entity',
            'item_kind': 'entity',
            'project_id': 'project-a',
            'source_project_id': 'project-b',
            'status': 'pending_conflict',
            'matched_item_id': 'target-entity',
            'reason': '供 A 项目使用',
            'created_at': changed_at,
            'updated_at': changed_at,
        }}],
        [{'conflict': {
            'id': 'conflict-1',
            'item_id': 'source-entity',
            'target_item_id': 'target-entity',
            'source_project_id': 'project-b',
            'target_project_id': 'project-a',
            'status': 'pending',
            'resolution': 'defer',
            'reason': '供 A 项目使用',
            'created_at': changed_at,
            'updated_at': changed_at,
        }}],
        [{'id': 'relation-1'}],
    ])
    store = StoreStub(driver)

    result = await apply_knowledge_project_action(
        store,
        {'id': 'principal-1'},
        'source-entity',
        KnowledgeProjectActionRequest(
            personal_space_id='personal-space',
            mode='existing',
            target_project_id='project-a',
            keep_source_relation=True,
            conflict_resolution='defer',
            reason='供 A 项目使用',
        ),
    )

    assert result.status == 'conflict_pending'
    assert result.source_project_id == 'project-b'
    assert result.reference.status == 'pending_conflict'
    assert result.conflict.status == 'pending'
    assert any('PERSONAL_PROJECT_RELATION' in query for query, _ in driver.calls)
    assert not any('FuliKnowledgeAssignment' in query and 'SET assignment' in query
                   for query, _ in driver.calls)


def test_new_project_relation_points_from_extracted_child_to_original_parent():
    create_request = KnowledgeProjectActionRequest(
        personal_space_id='personal-space',
        mode='create',
        new_project_id='hotel-theme',
        new_project_name='酒店主题',
        relation_type='PART_OF',
        reason='从活动承接拆出酒店主题',
    )
    existing_request = KnowledgeProjectActionRequest(
        personal_space_id='personal-space',
        mode='existing',
        target_project_id='activity-fulfillment',
        relation_type='PART_OF',
        reason='加入已有项目',
    )

    assert _relation_endpoints(
        'activity-fulfillment', 'hotel-theme', create_request
    ) == ('hotel-theme', 'activity-fulfillment')
    assert _relation_endpoints(
        'hotel-theme', 'activity-fulfillment', existing_request
    ) == ('hotel-theme', 'activity-fulfillment')


class SequentialDriver:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return next(self.responses), None, None


class EmbedderStub:
    async def create_batch(self, values):
        return [[float(len(value))] for value in values]


class RuntimeStub:
    def __init__(self, driver):
        self.driver = driver
        self.embedder = EmbedderStub()


class SettingsStub:
    provider_mode = 'personal'


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
