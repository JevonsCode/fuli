"""rec#20 part 1 contracts that need no graph: receipt scopes, scope edits,
item categories and the version check."""

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from fuli_graph.knowledge_item_version import require_item_version
from fuli_graph.knowledge_item_view import item_category
from fuli_graph.knowledge_item_view_models import KnowledgeScopeChange
from fuli_graph.models import EntityInput, KnowledgeCommit
from fuli_graph.task_context_models import TaskCaptureReceipt

SAVED = {'status': 'committed', 'episode_id': 'episode', 'entity_ids': ['entity']}


def test_a_session_temporary_receipt_names_its_temporary_project():
    receipt = TaskCaptureReceipt(scope='session_temporary', personal_project_id='temporary-' + 'a' * 64, **SAVED)
    assert receipt.scope == 'session_temporary'
    with pytest.raises(ValidationError):
        TaskCaptureReceipt(scope='session_temporary', personal_project_id='alpha', **SAVED)
    disabled = TaskCaptureReceipt(scope='session_temporary', status='capture_disabled')
    assert disabled.personal_project_id is None


def test_scope_edits_name_exactly_what_they_need():
    base = {'personal_space_id': 's', 'item_kind': 'entity', 'expected_version': 2, 'reason': 'r'}
    assert KnowledgeScopeChange(**base, scope='global').project_ids == []
    assert KnowledgeScopeChange(**base, scope='projects', project_ids=['a', 'b']).operation_actor == 'human'
    for invalid in [{'scope': 'global', 'project_ids': ['a']}, {'scope': 'projects'},
                    {'scope': 'projects', 'project_ids': ['a', 'a']}, {'scope': 'agent', 'project_ids': ['a']},
                    {'scope': 'agent', 'project_ids': ['a', 'b'], 'agent_id': 'x'},
                    {'scope': 'global', 'operation_actor': 'agent'}, {'scope': 'global', 'expected_version': -1}]:
        with pytest.raises(ValidationError):
            KnowledgeScopeChange(**{**base, **invalid})


def test_an_old_version_is_a_conflict_with_the_current_one():
    require_item_version({'ai_review_lock_version': 4}, None)
    require_item_version({'ai_review_lock_version': 4}, 4)
    with pytest.raises(HTTPException) as refused:
        require_item_version({'ai_review_lock_version': 5}, 4)
    assert refused.value.status_code == 409
    assert refused.value.detail['code'] == 'stale_version'
    assert refused.value.detail['current_version'] == 5


def test_categories_come_from_the_stored_aspect_or_type():
    assert item_category('taste', 'PersonalPreference') == 'taste'
    assert item_category('judgment_preference', 'X') == 'judgment'
    assert item_category(None, 'ReusableExperience') == 'experience'
    assert item_category(None, 'TeamConvention') == 'rule'
    assert item_category(None, 'ProjectFact') == 'fact'
    assert item_category(None, 'System') == 'knowledge'


def test_capture_carries_its_content_source_and_undecided_scope():
    entity = EntityInput(key='k', name='n', type='PersonalPreference', content_source='user_explicit')
    assert entity.content_source == 'user_explicit'
    with pytest.raises(ValidationError):
        EntityInput(key='k', name='n', type='T', content_source='model_claimed')
    commit = KnowledgeCommit(space_id='s', personal_project_id='temporary-x', scope_status='undetermined', episode={
        'idempotency_key': 'synthetic-key', 'session_id': 's', 'name': 'n', 'source_kind': 'k',
        'source_description': 'd', 'reference_time': '2026-10-21T00:00:00Z',
        'entities': [{'key': 'k', 'name': 'n', 'type': 'T'}]})
    assert commit.scope_status == 'undetermined'
