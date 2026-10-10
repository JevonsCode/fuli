from datetime import datetime, timezone

import pytest

from fuli_graph.ai_review import ai_review_evidence_token, effective_ai_review


def test_evidence_token_is_stable_but_changes_with_direct_content_and_scoped_state():
    item = {
        'item_kind': 'entity',
        'item_id': 'item-1',
        'title': 'Release notes',
        'content': 'Prefer concise release notes.',
        'valid_at': datetime(2026, 8, 1, tzinfo=timezone.utc),
        'invalid_at': None,
        'confirmation_status': 'pending',
        'confirmation_basis_json': None,
        'profile_aspect': None,
        'preference_scope': None,
        'preference_project_id': None,
        'preference_agent_id': None,
        'inheritance_mode': 'local_only',
        'current_quadrant': 'known_known',
        'requires_attention': False,
        'negative_evidence_count': 0,
        'human_change_version': 2,
        'project_ids': ['project-a'],
    }

    first = ai_review_evidence_token(
        item,
        scope='project',
        personal_project_id='project-a',
        has_conflict=False,
    )
    assert first == ai_review_evidence_token(
        item,
        scope='project',
        personal_project_id='project-a',
        has_conflict=False,
    )
    assert first != ai_review_evidence_token(
        {**item, 'content': 'Prefer short release notes.'},
        scope='project',
        personal_project_id='project-a',
        has_conflict=False,
    )
    assert first != ai_review_evidence_token(
        item,
        scope='project',
        personal_project_id='project-a',
        has_conflict=True,
    )
    assert first != ai_review_evidence_token(
        {**item, 'project_ids': ['project-a', 'project-b']},
        scope='project',
        personal_project_id='project-a',
        has_conflict=False,
    )
    for field, value in {
        'confirmation_status': 'confirmed',
        'profile_aspect': 'judgment_preference',
        'requires_attention': True,
        'negative_evidence_count': 1,
        'human_change_version': 3,
        'invalid_at': datetime(2026, 8, 2, tzinfo=timezone.utc),
    }.items():
        assert first != ai_review_evidence_token(
            {**item, field: value},
            scope='project',
            personal_project_id='project-a',
            has_conflict=False,
        )


def test_effective_ai_review_hides_stale_or_attention_bound_assessments():
    item = {
        'item_kind': 'entity',
        'item_id': 'item-1',
        'title': 'Release notes',
        'content': 'Prefer concise release notes.',
        'valid_at': None,
        'invalid_at': None,
        'confirmation_status': 'pending',
        'confirmation_basis_json': None,
        'profile_aspect': None,
        'preference_scope': None,
        'preference_project_id': None,
        'preference_agent_id': None,
        'inheritance_mode': 'local_only',
        'current_quadrant': 'known_known',
        'requires_attention': False,
        'negative_evidence_count': 0,
        'human_change_version': 1,
        'project_ids': [],
    }
    token = ai_review_evidence_token(
        item,
        scope='all',
        personal_project_id=None,
        has_conflict=False,
    )
    assessment = {'outcome': 'approve', 'summary': 'Still useful.', 'evidence': ['direct fact']}

    assert effective_ai_review(
        item,
        stored_token=token,
        stored_assessment=assessment,
        scope='all',
        personal_project_id=None,
        has_conflict=False,
    ) == assessment
    assert effective_ai_review(
        {**item, 'content': 'Prefer detailed release notes.'},
        stored_token=token,
        stored_assessment=assessment,
        scope='all',
        personal_project_id=None,
        has_conflict=False,
    ) is None
    assert effective_ai_review(
        item,
        stored_token=token,
        stored_assessment=assessment,
        scope='all',
        personal_project_id=None,
        has_conflict=True,
    ) is None
