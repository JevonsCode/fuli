from datetime import datetime, timezone

import pytest

from fuli_graph.knowledge_review import (
    _CONFLICT_ITEM_QUERY,
    LOW_CONFIDENCE_SCORE,
    LOW_UTILITY_SCORE,
    REPEATED_SESSION_COUNT,
    build_review_candidates,
    finish_knowledge_review,
    start_knowledge_review,
)
from fuli_graph.knowledge_review_models import (
    KnowledgeReviewFinish,
    KnowledgeReviewStart,
)


def test_candidate_order_matches_review_policy_and_keeps_all_reasons():
    watermark = datetime(2026, 7, 1, tzinfo=timezone.utc)
    rows = [
        item_row(
            'recent',
            created_at=datetime(2026, 7, 2, tzinfo=timezone.utc),
            project_ids=['project-a'],
            utility_score=0.8,
            confidence_score=0.9,
        ),
        item_row(
            'conflict',
            created_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
            requires_attention=True,
            negative_evidence_count=2,
            utility_score=LOW_UTILITY_SCORE,
            project_ids=['project-a'],
        ),
        item_row(
            'low',
            created_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
            utility_score=LOW_UTILITY_SCORE,
            confidence_score=LOW_CONFIDENCE_SCORE,
            project_ids=['project-a'],
        ),
        item_row(
            'repeated',
            created_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
            session_ids=[f'session-{index}' for index in range(REPEATED_SESSION_COUNT)],
            project_ids=['project-a'],
        ),
    ]

    candidates = build_review_candidates(
        rows,
        scope='all',
        personal_project_id=None,
        previous_completed_at=watermark,
        conflict_item_keys={'entity:conflict'},
        decided_candidate_keys=set(),
    )

    assert [candidate.item_id for candidate in candidates] == [
        'recent', 'conflict', 'low', 'repeated'
    ]
    assert candidates[1].reasons == ['conflict_or_attention', 'low_weight']


def test_first_review_scans_every_in_scope_item_and_completed_items_stay_out_of_run():
    rows = [
        item_row('global-pref', profile_aspect='taste', preference_scope='global'),
        item_row('project-pref', profile_aspect='taste', preference_scope='project',
                 preference_project_id='project-a'),
        item_row('project-fact', project_ids=['project-a']),
        item_row('unscoped-fact'),
    ]

    candidates = build_review_candidates(
        rows,
        scope='all',
        personal_project_id=None,
        previous_completed_at=None,
        conflict_item_keys=set(),
        decided_candidate_keys={'entity:project-pref'},
    )

    assert [candidate.item_id for candidate in candidates] == [
        'global-pref', 'project-fact'
    ]
    assert all(candidate.reasons[0] == 'changed_since_last' for candidate in candidates)


def test_repeated_pattern_is_combined_across_distinct_session_items():
    rows = [
        item_row(
            f'item-{index}',
            content='Prefer concise release notes.',
            project_ids=['project-a'],
            session_ids=[f'session-{index}'],
        )
        for index in range(REPEATED_SESSION_COUNT)
    ]

    candidates = build_review_candidates(
        rows,
        scope='project',
        personal_project_id='project-a',
        previous_completed_at=datetime(2026, 7, 1, tzinfo=timezone.utc),
        conflict_item_keys=set(),
        decided_candidate_keys=set(),
    )

    assert len(candidates) == 1
    assert candidates[0].reasons == ['repeated_cross_session']
    assert candidates[0].distinct_session_count == REPEATED_SESSION_COUNT


def test_review_cutoff_leaves_concurrent_changes_for_the_next_run():
    candidates = build_review_candidates(
        [item_row(
            'changed-during-review',
            project_ids=['project-a'],
            created_at=datetime(2026, 8, 1, 8, 1, tzinfo=timezone.utc),
        )],
        scope='project',
        personal_project_id='project-a',
        previous_completed_at=datetime(2026, 7, 1, tzinfo=timezone.utc),
        review_cutoff_at=datetime(2026, 8, 1, 8, 0, tzinfo=timezone.utc),
        conflict_item_keys=set(),
        decided_candidate_keys=set(),
    )

    assert candidates == []


def test_conflict_lookup_covers_entities_and_relationships():
    assert "'entity:' + knowledge.item_id" in _CONFLICT_ITEM_QUERY
    assert "'relationship:' + knowledge.item_id" in _CONFLICT_ITEM_QUERY
    assert "'entity:' + knowledge.target_item_id" in _CONFLICT_ITEM_QUERY
    assert "'relationship:' + knowledge.target_item_id" in _CONFLICT_ITEM_QUERY


@pytest.mark.asyncio
async def test_start_reports_resume_only_when_a_paused_run_becomes_active():
    started_at = datetime(2026, 8, 1, 8, 0, tzinfo=timezone.utc)
    active_driver = SequentialDriver([[
        {'run': run_record('review-active', 'active', started_at)}
    ]])
    paused_driver = SequentialDriver([
        [{'run': run_record('review-paused', 'paused', started_at)}],
        [{'run': run_record('review-paused', 'active', started_at)}],
    ])

    active = await start_knowledge_review(
        StoreStub(active_driver),
        {'id': 'principal-1'},
        KnowledgeReviewStart(personal_space_id='personal-space', scope='all'),
        started_at=started_at,
    )
    resumed = await start_knowledge_review(
        StoreStub(paused_driver),
        {'id': 'principal-1'},
        KnowledgeReviewStart(personal_space_id='personal-space', scope='all'),
        started_at=started_at,
    )

    assert active.resumed is False
    assert resumed.resumed is True


@pytest.mark.asyncio
async def test_review_resume_and_watermark_advance_only_on_completion():
    started_at = datetime(2026, 8, 1, 8, 0, tzinfo=timezone.utc)
    driver = SequentialDriver([
        [],
        [],
        [{'run': run_record('review-1', 'active', started_at)}],
        [{'run': run_record('review-1', 'paused', started_at)}],
        [{'run': run_record('review-1', 'completed', started_at,
                            completed_at=started_at)}],
    ])
    store = StoreStub(driver)

    run = await start_knowledge_review(
        store,
        {'id': 'principal-1'},
        KnowledgeReviewStart(personal_space_id='personal-space', scope='all'),
        started_at=started_at,
    )
    paused = await finish_knowledge_review(
        store,
        {'id': 'principal-1'},
        KnowledgeReviewFinish(
            personal_space_id='personal-space',
            review_id=run.review_id,
            disposition='paused',
        ),
        changed_at=started_at,
    )
    completed = await finish_knowledge_review(
        store,
        {'id': 'principal-1'},
        KnowledgeReviewFinish(
            personal_space_id='personal-space',
            review_id=run.review_id,
            disposition='completed',
        ),
        changed_at=started_at,
    )

    assert run.previous_completed_at is None
    assert paused.completed_at is None
    assert completed.completed_at == started_at
    assert driver.calls[3][1]['completed_at'] is None
    assert driver.calls[4][1]['completed_at'] == started_at


def item_row(item_id, **overrides):
    value = {
        'item_id': item_id,
        'item_kind': 'entity',
        'title': item_id,
        'content': f'Knowledge {item_id}',
        'profile_aspect': None,
        'preference_scope': None,
        'preference_project_id': None,
        'project_ids': [],
        'session_ids': [],
        'confirmation_status': 'confirmed',
        'utility_score': 0.7,
        'confidence_score': 0.8,
        'qualified_use_count': 1,
        'distinct_task_count': 1,
        'negative_evidence_count': 0,
        'requires_attention': False,
        'last_feedback_kind': None,
        'created_at': datetime(2026, 6, 1, tzinfo=timezone.utc),
        'last_human_changed_at': None,
        'last_feedback_at': None,
        'last_revision_at': None,
    }
    value.update(overrides)
    return value


def run_record(review_id, status, started_at, completed_at=None):
    return {
        'id': review_id,
        'personal_space_id': 'personal-space',
        'scope': 'all',
        'personal_project_id': None,
        'scope_key': 'all',
        'status': status,
        'previous_completed_at': None,
        'started_at': started_at,
        'updated_at': started_at,
        'completed_at': completed_at,
    }


class SequentialDriver:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return next(self.responses), None, None


class StoreStub:
    def __init__(self, driver):
        self.runtime = type('Runtime', (), {'driver': driver})()
        self.settings = type('Settings', (), {'provider_mode': 'personal'})()

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
