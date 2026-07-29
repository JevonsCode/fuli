from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from fuli_graph.models import (
    KnowledgeBatchConfirmationCreate,
    KnowledgeRevisionCreate,
    PreferenceScopeChange,
    ProjectProfile,
    ProjectReleaseCreate,
    ProjectRelationCreate,
    PublicationDraftCreate,
    SearchRequest,
    SpaceRecord,
    StructuredEpisode,
)


def episode(**overrides):
    value = {
        'idempotency_key': 'session-1-batch-1',
        'session_id': 'session-1',
        'name': 'Project evidence',
        'source_kind': 'conversation',
        'source_description': 'Confirmed project discussion',
        'reference_time': datetime(2026, 7, 21, tzinfo=timezone.utc),
        'summary': 'A code symbol is motivated by a PRD section',
        'sensitivity': 'normal',
        'entities': [
            {'key': 'code:checkout', 'name': 'checkout', 'type': 'CodeSymbol'},
            {'key': 'prd:coupon-status', 'name': 'Coupon status', 'type': 'PRDSection'},
        ],
        'relationships': [{
            'key': 'checkout-defined-by-prd',
            'source': 'code:checkout',
            'target': 'prd:coupon-status',
            'type': 'DEFINED_BY',
            'fact': 'Checkout coupon status follows the approved PRD section.',
        }],
    }
    value.update(overrides)
    return value


def confirmed_episode(**overrides):
    value = episode(**overrides)
    basis = {
        'existence_reason': 'The user explicitly reviewed this project knowledge.',
        'quadrant_reason': 'The item was explicitly expressed when captured.',
        'proposed_by': {'kind': 'agent', 'label': 'Codex'},
        'confirmed_by': {'kind': 'user', 'label': 'Current user'},
        'confirmed_at': datetime(2026, 7, 21, tzinfo=timezone.utc),
    }
    for item in [*value['entities'], *value['relationships']]:
        item['confirmation_status'] = 'confirmed'
        item['confirmation_basis'] = basis
    return value


def test_structured_episode_accepts_explicit_source_entities():
    parsed = StructuredEpisode.model_validate(episode(
        source_application='codex',
        source_turn_id='turn-7',
        source_excerpt='The user confirmed the project boundary.',
    ))
    assert parsed.entities[0].type == 'CodeSymbol'
    assert parsed.relationships[0].type == 'DEFINED_BY'
    assert parsed.source_application == 'codex'
    assert parsed.source_turn_id == 'turn-7'
    assert parsed.entities[0].confirmation_status == 'pending'
    assert parsed.entities[0].confirmation_basis.proposed_by.kind == 'agent'


def test_confirmation_requires_a_non_agent_confirmer_and_timestamp():
    value = episode()
    value['entities'][0] |= {
        'confirmation_status': 'confirmed',
        'confirmation_basis': {
            'existence_reason': 'Agent inference',
            'quadrant_reason': 'Explicit statement',
            'proposed_by': {'kind': 'agent'},
            'confirmed_by': {'kind': 'agent'},
            'confirmed_at': datetime(2026, 7, 21, tzinfo=timezone.utc),
        },
    }

    with pytest.raises(ValidationError, match='agent or import cannot confirm'):
        StructuredEpisode.model_validate(value)


def test_agent_confirmation_requires_policy_evidence_and_never_enters_public_review():
    value = episode()
    basis = {
        'existence_reason': 'Repeated material use retained this knowledge.',
        'quadrant_reason': 'The discovery-time quadrant remains unchanged.',
        'proposed_by': {'kind': 'agent', 'label': 'Codex'},
        'confirmed_by': {'kind': 'agent', 'label': 'Fuli usage policy'},
        'confirmed_at': datetime(2026, 7, 29, tzinfo=timezone.utc),
        'agent_policy_version': 'agent-usage-v1',
    }
    for item in [*value['entities'], *value['relationships']]:
        item['confirmation_status'] = 'agent_confirmed'
        item['confirmation_basis'] = basis

    parsed = StructuredEpisode.model_validate(value)

    assert parsed.entities[0].confirmation_status == 'agent_confirmed'
    assert parsed.entities[0].confirmation_basis.agent_policy_version == (
        'agent-usage-v1'
    )
    with pytest.raises(ValidationError, match='auditable confirmation'):
        PublicationDraftCreate(
            personal_space_id='personal-space',
            target_project_id='project-a',
            provider_url='https://provider.example',
            episode=parsed,
        )


def test_agent_confirmed_cannot_be_written_through_the_revision_api():
    with pytest.raises(ValidationError, match='knowledge usage policy'):
        KnowledgeRevisionCreate(
            personal_space_id='personal-space',
            item_kind='entity',
            action='update',
            reason='Attempted manual Agent promotion.',
            confirmation_status='agent_confirmed',
            confirmation_basis={
                'existence_reason': 'Repeated material use retained this knowledge.',
                'quadrant_reason': 'The discovery-time quadrant remains unchanged.',
                'proposed_by': {'kind': 'agent'},
                'confirmed_by': {'kind': 'agent'},
                'confirmed_at': datetime(2026, 7, 29, tzinfo=timezone.utc),
                'agent_policy_version': 'agent-usage-v1',
            },
        )


def test_selected_project_inheritance_is_explicit_and_preferences_never_inherit():
    value = episode()
    value['entities'][0]['inheritance_mode'] = 'selected_projects'
    value['entities'][0]['inherited_project_ids'] = ['hotel-project']
    parsed = StructuredEpisode.model_validate(value)
    assert parsed.entities[0].inherited_project_ids == ['hotel-project']

    value['entities'][0]['profile_aspect'] = 'taste'
    with pytest.raises(ValidationError, match='preferences cannot inherit'):
        StructuredEpisode.model_validate(value)

    with pytest.raises(ValidationError, match='must be updated together'):
        KnowledgeRevisionCreate(
            personal_space_id='personal-space',
            item_kind='entity',
            action='update',
            reason='Incomplete inheritance update.',
            inheritance_mode='descendants',
        )


def test_single_confirmation_cannot_change_content_or_taxonomy():
    basis = {
        'existence_reason': 'The user stated the preference.',
        'quadrant_reason': 'It was explicitly expressed.',
        'proposed_by': {'kind': 'agent', 'label': 'Codex'},
        'confirmed_by': {'kind': 'user', 'label': 'Current user'},
        'confirmed_at': datetime.now(timezone.utc),
    }

    request = KnowledgeRevisionCreate(
        personal_space_id='personal-space',
        item_kind='entity',
        action='confirm',
        reason='Reviewed.',
        confirmation_status='confirmed',
        confirmation_basis=basis,
    )
    assert request.action == 'confirm'

    with pytest.raises(
        ValidationError,
        match='cannot change knowledge content or taxonomy',
    ):
        KnowledgeRevisionCreate(
            personal_space_id='personal-space',
            item_kind='entity',
            action='confirm',
            reason='Reviewed and renamed.',
            name='Changed name',
            confirmation_status='confirmed',
            confirmation_basis=basis,
        )


def test_replacement_link_requires_a_complete_structured_target():
    request = KnowledgeRevisionCreate(
        personal_space_id='personal-space',
        item_kind='entity',
        action='invalidate',
        reason='A newer requirement replaces this one.',
        replacement_item_id='entity-current',
        replacement_item_kind='entity',
    )
    assert request.replacement_item_id == 'entity-current'

    with pytest.raises(ValidationError, match='id and kind must be provided together'):
        KnowledgeRevisionCreate(
            personal_space_id='personal-space',
            item_kind='entity',
            action='invalidate',
            reason='Incomplete replacement reference.',
            replacement_item_id='entity-current',
        )

    with pytest.raises(ValidationError, match='requires a replacement item'):
        KnowledgeRevisionCreate(
            personal_space_id='personal-space',
            item_kind='entity',
            action='link_replacement',
            reason='Missing replacement reference.',
        )

    with pytest.raises(ValidationError, match='only valid when invalidating or linking'):
        KnowledgeRevisionCreate(
            personal_space_id='personal-space',
            item_kind='entity',
            action='restore',
            reason='Restore the old requirement.',
            replacement_item_id='entity-current',
            replacement_item_kind='entity',
        )


def test_batch_confirmation_requires_unique_items_and_a_human_or_authoritative_confirmer():
    value = {
        'personal_space_id': 'personal-space',
        'group_kind': 'session',
        'group_value': 'session-1',
        'reason': 'Reviewed this source session.',
        'confirmer': {'kind': 'user'},
        'items': [
            {
                'item_id': 'entity-1',
                'item_kind': 'entity',
                'existence_reason': 'Captured from the reviewed session.',
                'quadrant_reason': 'Explicitly stated during the session.',
                'proposed_by': {'kind': 'agent', 'label': 'Codex'},
            },
            {
                'item_id': 'relationship-1',
                'item_kind': 'relationship',
                'existence_reason': 'Captured from the reviewed session.',
                'quadrant_reason': 'Explicitly stated during the session.',
                'proposed_by': {'kind': 'agent', 'label': 'Codex'},
            },
        ],
    }

    parsed = KnowledgeBatchConfirmationCreate.model_validate(value)
    assert len(parsed.items) == 2

    with pytest.raises(ValidationError, match='agent or import cannot confirm'):
        KnowledgeBatchConfirmationCreate.model_validate(
            value | {'confirmer': {'kind': 'agent', 'label': 'Codex'}}
        )
    with pytest.raises(ValidationError, match='must be unique'):
        KnowledgeBatchConfirmationCreate.model_validate(
            value | {'items': [value['items'][0], value['items'][0]]}
        )


def test_structured_episode_rejects_credentials_at_provider_boundary():
    with pytest.raises(ValidationError, match='contains credentials'):
        StructuredEpisode.model_validate(episode(summary='api_key=sk-live-12345678901234567890'))


def test_structured_episode_rejects_missing_relationship_entities():
    relation = episode()['relationships'][0] | {'target': 'prd:missing'}
    with pytest.raises(ValidationError, match='must reference episode entities'):
        StructuredEpisode.model_validate(episode(relationships=[relation]))


def test_structured_episode_requires_one_current_replacement_per_superseded_relationship():
    first = episode()['relationships'][0] | {
        'key': 'replacement-a',
        'supersedes': ['old-rule'],
    }
    second = episode()['relationships'][0] | {
        'key': 'replacement-b',
        'supersedes': ['old-rule'],
    }
    with pytest.raises(ValidationError, match='cannot have multiple replacements'):
        StructuredEpisode.model_validate(episode(relationships=[first, second]))

    with pytest.raises(ValidationError, match='invalid relationship cannot replace'):
        StructuredEpisode.model_validate(episode(relationships=[{
            **first,
            'invalid_at': datetime(2026, 7, 22, tzinfo=timezone.utc),
        }]))


def test_public_project_record_exposes_owner_and_effective_role():
    project = SpaceRecord.model_validate({
        'id': 'project-1',
        'name': 'Hotel Theme',
        'kind': 'project',
        'group_id': 'workspace-project-project-1',
        'description': 'A complete project profile is optional at publication time.',
        'visibility': 'public',
        'owner_id': 'principal-1',
        'role': 'maintainer',
        'created_at': datetime(2026, 7, 21, tzinfo=timezone.utc),
    })

    assert project.owner_id == 'principal-1'
    assert project.role == 'maintainer'
    assert project.visibility == 'public'


def test_project_profile_summarizes_existing_evidence_and_discards_legacy_missing_claims():
    profile = ProjectProfile.model_validate({
        'name': 'Hotel Theme',
        'purpose': 'Deliver hotel themed campaign pages.',
        'scope': 'Frontend presentation and activity configuration.',
        'lifecycle': 'active',
        'sources': [
            {
                'key': 'prd',
                'kind': 'prd',
                'title': 'Product requirements',
                'uri': 'https://docs.example/project/prd',
                'sensitivity': 'normal',
            },
            {
                'key': 'frontend',
                'kind': 'frontend_repository',
                'title': 'Frontend repository',
                'uri': 'https://git.example/project/frontend',
                'sensitivity': 'normal',
            },
        ],
        'boundaries': ['Do not change shared modules without impact analysis.'],
        'assessment': {
            'score': 58,
            'label': 'partially_documented',
            'confirmed': ['PRD is linked.'],
            'inferred': ['A backend service probably exists.'],
            'missing': ['Backend repository', 'Runbook'],
            'dimensions': [{
                'key': 'documentation',
                'label': 'Documentation',
                'score': 70,
                'state': 'confirmed',
                'evidence': ['PRD link'],
                'missing': ['Technical design'],
            }],
            'analyzed_at': '2026-07-21T10:00:00Z',
        },
    })

    assert profile.assessment.score == 58
    assert 'missing' not in profile.assessment.model_dump()
    assert 'missing' not in profile.assessment.dimensions[0].model_dump()
    assert profile.sources[1].kind == 'frontend_repository'


def test_non_known_known_items_require_reasoning_and_preserve_discovery_quadrant():
    value = episode()
    value['entities'][0] |= {
        'origin_quadrant': 'unknown_known',
        'reasoning_summary': 'The user recognized this criterion after comparing prototypes.',
        'profile_aspect': 'taste',
    }
    parsed = StructuredEpisode.model_validate(value)

    assert parsed.entities[0].origin_quadrant == 'unknown_known'
    assert parsed.entities[0].current_quadrant == 'unknown_known'
    with pytest.raises(ValidationError, match='requires a reasoning summary'):
        StructuredEpisode.model_validate(episode(entities=[{
            'key': 'idea:one',
            'name': 'Unresolved idea',
            'type': 'Idea',
            'origin_quadrant': 'unknown_unknown',
            'epistemic_status': 'exploratory',
        }], relationships=[]))


def test_project_relation_supports_explicit_dependency_and_hierarchy_types():
    relation = ProjectRelationCreate.model_validate({
        'target_project_id': 'activity-platform',
        'relation_type': 'PART_OF',
        'note': 'Hotel Theme is delivered inside the activity platform domain.',
    })

    assert relation.relation_type == 'PART_OF'


def test_project_release_requires_safe_version_and_nonempty_update_summary():
    release = ProjectReleaseCreate.model_validate({
        'version': 'v1.2.0-beta.1',
        'summary': 'Add public project release history.',
    })

    assert release.version == 'v1.2.0-beta.1'
    with pytest.raises(ValidationError):
        ProjectReleaseCreate.model_validate({'version': 'v1 / latest', 'summary': 'Unsafe'})
    with pytest.raises(ValidationError):
        ProjectReleaseCreate.model_validate({'version': 'v1.0.0', 'summary': ' '})


def test_publication_draft_retains_the_full_structured_episode_for_personal_review():
    draft = PublicationDraftCreate.model_validate({
        'personal_space_id': 'personal-space',
        'target_project_id': 'project-1',
        'provider_url': 'https://provider.example',
        'episode': confirmed_episode(),
    })

    assert draft.episode.relationships[0].fact.startswith('Checkout')
    assert draft.target_project_id == 'project-1'


def test_public_review_rejects_unresolved_or_personal_profile_knowledge():
    unresolved = episode()
    unresolved['relationships'][0] |= {
        'origin_quadrant': 'known_unknown',
        'current_quadrant': 'known_unknown',
        'epistemic_status': 'observed',
        'reasoning_summary': 'The tradeoff is still unresolved.',
    }
    with pytest.raises(ValidationError, match='auditable confirmation'):
        PublicationDraftCreate.model_validate({
            'personal_space_id': 'personal-space',
            'target_project_id': 'project-1',
            'provider_url': 'https://provider.example',
            'episode': unresolved,
        })

    profile = confirmed_episode()
    profile['entities'][0] |= {'profile_aspect': 'taste'}
    with pytest.raises(ValidationError, match='Personal profile'):
        PublicationDraftCreate.model_validate({
            'personal_space_id': 'personal-space',
            'target_project_id': 'project-1',
            'provider_url': 'https://provider.example',
            'episode': profile,
        })


def test_knowledge_revision_requires_meaningful_content_and_a_reason():
    revision = KnowledgeRevisionCreate.model_validate({
        'personal_space_id': 'personal-space',
        'personal_project_id': 'fuli',
        'item_kind': 'entity',
        'action': 'update',
        'reason': '摘要沉淀不完整',
        'summary': '完整且经过确认的内容',
    })

    assert revision.summary == '完整且经过确认的内容'
    with pytest.raises(ValidationError, match='requires content or epistemic metadata'):
        KnowledgeRevisionCreate.model_validate({
            'personal_space_id': 'personal-space',
            'item_kind': 'entity',
            'action': 'update',
            'reason': '没有提供新内容',
        })

    transition = KnowledgeRevisionCreate.model_validate({
        'personal_space_id': 'personal-space',
        'item_kind': 'entity',
        'action': 'update',
        'reason': '用户已经确认原型中体现的判断标准',
        'origin_quadrant': 'unknown_known',
        'confirmation_status': 'confirmed',
        'confirmation_basis': {
            'existence_reason': '原型比较中出现稳定偏好',
            'quadrant_reason': '偏好由多次反应归纳而来',
            'proposed_by': {'kind': 'agent'},
            'confirmed_by': {'kind': 'user'},
            'confirmed_at': datetime(2026, 7, 21, tzinfo=timezone.utc),
        },
    })
    assert transition.origin_quadrant == 'unknown_known'
    assert transition.confirmation_status == 'confirmed'


def test_preference_scope_requires_exactly_one_project_for_project_scope():
    project = PreferenceScopeChange.model_validate({
        'personal_space_id': 'personal-space',
        'item_kind': 'entity',
        'scope': 'project',
        'project_id': 'fuli',
        'reason': 'Only applies to this project',
    })
    assert project.project_id == 'fuli'
    with pytest.raises(ValidationError, match='project_id is required'):
        PreferenceScopeChange.model_validate({
            'personal_space_id': 'personal-space',
            'item_kind': 'entity',
            'scope': 'project',
            'reason': 'Missing target',
        })
    with pytest.raises(ValidationError, match='only valid'):
        PreferenceScopeChange.model_validate({
            'personal_space_id': 'personal-space',
            'item_kind': 'entity',
            'scope': 'global',
            'project_id': 'fuli',
            'reason': 'Invalid extra target',
        })

def test_personal_search_scope_requires_unique_explicit_project_ids():
    request = SearchRequest.model_validate({
        'space_ids': ['personal-space'],
        'query': '参考 B 项目的按钮规范',
        'personal_project_ids': ['project-a', 'project-b'],
        'include_personal_global': True,
    })

    assert request.personal_project_ids == ['project-a', 'project-b']
    assert request.include_personal_global is True
    assert SearchRequest.model_validate({
        'space_ids': ['personal-space'],
        'query': '兼容旧调用',
        'include_exploratory': True,
    }).include_pending is True
    with pytest.raises(ValidationError, match='must be unique'):
        SearchRequest.model_validate({
            'space_ids': ['personal-space'],
            'query': '重复项目',
            'personal_project_ids': ['project-a', 'project-a'],
        })
