from datetime import datetime, timezone
from contextlib import asynccontextmanager

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from fuli_graph.knowledge_review import (
    _CONFLICT_ITEM_QUERY,
    _DEFERRED_ITEM_QUERY,
    LOW_CONFIDENCE_SCORE,
    LOW_UTILITY_SCORE,
    REPEATED_SESSION_COUNT,
    build_review_candidates,
    finish_knowledge_review,
    record_knowledge_review_progress,
    start_knowledge_review,
)
from fuli_graph.knowledge_review_models import (
    KnowledgeReviewAIAssessment,
    KnowledgeReviewCandidate,
    KnowledgeReviewFinish,
    KnowledgeReviewProgress,
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


def test_deferred_item_returns_even_when_no_fixed_ranking_threshold_still_matches():
    watermark = datetime(2026, 7, 1, tzinfo=timezone.utc)
    rows = [item_row(
        'deferred',
        created_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        project_ids=['project-a'],
    )]

    candidates = build_review_candidates(
        rows,
        scope='project',
        personal_project_id='project-a',
        previous_completed_at=watermark,
        conflict_item_keys=set(),
        decided_candidate_keys=set(),
        deferred_candidate_keys={'entity:deferred'},
    )

    assert [candidate.item_id for candidate in candidates] == ['deferred']
    assert candidates[0].reasons == ['deferred_from_previous']
    assert candidates[0].priority == 1


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


def test_conflict_lookup_uses_explicit_neo4j_aggregation_grouping():
    assert 'WITH knowledge_keys,' in _CONFLICT_ITEM_QUERY
    assert 'AS preference_keys' in _CONFLICT_ITEM_QUERY
    assert 'RETURN knowledge_keys + preference_keys AS candidate_keys' in (
        _CONFLICT_ITEM_QUERY
    )


def test_conflict_lookup_is_project_scoped_when_a_project_review_runs():
    assert '$project_id IS NULL' in _CONFLICT_ITEM_QUERY
    assert 'knowledge.target_project_id = $project_id' in _CONFLICT_ITEM_QUERY
    assert 'preference.preference_project_id = $project_id' in _CONFLICT_ITEM_QUERY


def test_deferred_lookup_uses_the_latest_past_review_decision():
    assert 'past_run.id <> $review_id' in _DEFERRED_ITEM_QUERY
    assert 'ORDER BY decision.updated_at DESC' in _DEFERRED_ITEM_QUERY
    assert "latest_decision.outcome = 'deferred'" in _DEFERRED_ITEM_QUERY


def test_candidate_wire_order_keeps_review_reasons_before_optional_metadata():
    fields = list(KnowledgeReviewCandidate.model_fields)

    assert fields.index('reasons') < fields.index('profile_aspect')
    assert fields.index('confirmation_status') < fields.index('profile_aspect')


def test_candidate_exposes_the_mutable_current_quadrant():
    candidate = build_review_candidates(
        [item_row(
            'blind-spot',
            project_ids=['project-a'],
            current_quadrant='unknown_unknown',
        )],
        scope='project',
        personal_project_id='project-a',
        previous_completed_at=None,
        conflict_item_keys=set(),
        decided_candidate_keys=set(),
    )[0]

    assert candidate.current_quadrant == 'unknown_unknown'


def test_review_progress_supports_ai_delegation_and_rejects_retired_skip():
    progress = KnowledgeReviewProgress(
        personal_space_id='personal-space',
        review_id='review-1',
        candidate_key='entity:item-1',
        outcome='delegated_to_ai',
    )

    assert progress.outcome == 'delegated_to_ai'
    with pytest.raises(ValidationError):
        KnowledgeReviewProgress(
            personal_space_id='personal-space',
            review_id='review-1',
            candidate_key='entity:item-1',
            outcome='skipped',
        )


def test_ai_review_progress_requires_version_bound_assessment_and_token():
    with pytest.raises(ValidationError):
        KnowledgeReviewProgress(
            personal_space_id='personal-space',
            review_id='review-1',
            candidate_key='entity:item-1',
            outcome='ai_reviewed',
        )

    progress = KnowledgeReviewProgress(
        personal_space_id='personal-space',
        review_id='review-1',
        candidate_key='entity:item-1',
        outcome='ai_reviewed',
        ai_review_evidence_token='a' * 64,
        ai_assessment=KnowledgeReviewAIAssessment(
            outcome='approve',
            summary='The direct evidence is still useful.',
            evidence=['The current item content matches the review request.'],
            confidence=0.82,
        ),
    )

    assert progress.ai_review_evidence_token == 'a' * 64
    with pytest.raises(ValidationError):
        KnowledgeReviewProgress(
            personal_space_id='personal-space',
            review_id='review-1',
            candidate_key='entity:item-1',
            outcome='confirmed',
            ai_review_evidence_token='a' * 64,
            ai_assessment=progress.ai_assessment,
        )


@pytest.mark.asyncio
async def test_ai_review_progress_locks_and_rechecks_current_content_before_writing():
    item = item_row('item-1', project_ids=['project-a'])
    token = build_review_candidates(
        [item],
        scope='project',
        personal_project_id='project-a',
        previous_completed_at=None,
        conflict_item_keys=set(),
        decided_candidate_keys=set(),
    )[0].ai_review_evidence_token
    tx = TransactionStub([
        [{'run': run_record(
            'review-1', 'active', item['created_at'], reviewer='tonborg',
            scope='project', personal_project_id='project-a',
        )}],
        [{**item, 'has_conflict': False}],
        [{'decision': {
            'id': 'decision-1',
            'review_id': 'review-1',
            'candidate_key': 'entity:item-1',
            'outcome': 'ai_reviewed',
            'note': 'Tonborg review',
            'ai_review_evidence_token': token,
            'ai_assessment_json': '{"outcome":"approve","summary":"Useful",'
                                  '"evidence":["Direct item"],"confidence":0.8}',
            'created_at': item['created_at'],
            'updated_at': item['created_at'],
        }}],
    ])

    result = await record_knowledge_review_progress(
        StoreStub(TransactionRootDriver(tx)),
        {'id': 'principal-1'},
        KnowledgeReviewProgress(
            personal_space_id='personal-space',
            review_id='review-1',
            candidate_key='entity:item-1',
            outcome='ai_reviewed',
            ai_review_evidence_token=token,
            ai_assessment=KnowledgeReviewAIAssessment(
                outcome='approve',
                summary='Useful',
                evidence=['Direct item'],
                confidence=0.8,
            ),
        ),
    )

    assert result.ai_assessment.outcome == 'approve'
    assert 'SET item.fuli_ai_review_lock_version' in tx.calls[1][0]
    assert 'ai_assessment_json' in tx.calls[2][0]


@pytest.mark.asyncio
async def test_ai_review_progress_rejects_content_change_and_non_tonborg_runs():
    item = item_row('item-1', project_ids=['project-a'])
    token = build_review_candidates(
        [item],
        scope='project',
        personal_project_id='project-a',
        previous_completed_at=None,
        conflict_item_keys=set(),
        decided_candidate_keys=set(),
    )[0].ai_review_evidence_token
    assessment = KnowledgeReviewAIAssessment(
        outcome='approve', summary='Useful', evidence=['Direct item'], confidence=0.8
    )

    changed_tx = TransactionStub([
        [{'run': run_record(
            'review-1', 'active', item['created_at'], reviewer='tonborg',
            scope='project', personal_project_id='project-a',
        )}],
        [{**item, 'content': 'Changed while the model was reading.', 'has_conflict': False}],
    ])
    with pytest.raises(HTTPException) as changed:
        await record_knowledge_review_progress(
            StoreStub(TransactionRootDriver(changed_tx)),
            {'id': 'principal-1'},
            KnowledgeReviewProgress(
                personal_space_id='personal-space', review_id='review-1',
                candidate_key='entity:item-1', outcome='ai_reviewed',
                ai_review_evidence_token=token, ai_assessment=assessment,
            ),
        )
    assert changed.value.status_code == 409
    assert len(changed_tx.calls) == 2

    human_tx = TransactionStub([
        [{'run': run_record(
            'review-1', 'active', item['created_at'], reviewer='human',
            scope='project', personal_project_id='project-a',
        )}],
    ])
    with pytest.raises(HTTPException) as human:
        await record_knowledge_review_progress(
            StoreStub(TransactionRootDriver(human_tx)),
            {'id': 'principal-1'},
            KnowledgeReviewProgress(
                personal_space_id='personal-space', review_id='review-1',
                candidate_key='entity:item-1', outcome='ai_reviewed',
                ai_review_evidence_token=token, ai_assessment=assessment,
            ),
        )
    assert human.value.status_code == 403
    assert len(human_tx.calls) == 1


@pytest.mark.asyncio
async def test_ai_review_progress_rejects_a_candidate_that_left_the_project_scope():
    item = item_row('item-1', project_ids=['project-a'])
    token = build_review_candidates(
        [item],
        scope='project',
        personal_project_id='project-a',
        previous_completed_at=None,
        conflict_item_keys=set(),
        decided_candidate_keys=set(),
    )[0].ai_review_evidence_token
    tx = TransactionStub([
        [{'run': run_record(
            'review-1', 'active', item['created_at'], reviewer='tonborg',
            scope='project', personal_project_id='project-a',
        )}],
        [{**item, 'project_ids': ['project-b'], 'has_conflict': False}],
    ])
    with pytest.raises(HTTPException) as outside:
        await record_knowledge_review_progress(
            StoreStub(TransactionRootDriver(tx)),
            {'id': 'principal-1'},
            KnowledgeReviewProgress(
                personal_space_id='personal-space', review_id='review-1',
                candidate_key='entity:item-1', outcome='ai_reviewed',
                ai_review_evidence_token=token,
                ai_assessment=KnowledgeReviewAIAssessment(
                    outcome='approve', summary='Useful', evidence=['Direct item'], confidence=0.8
                ),
            ),
        )
    assert outside.value.status_code == 409


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
        'current_quadrant': 'known_known',
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


def run_record(
    review_id,
    status,
    started_at,
    completed_at=None,
    reviewer='human',
    scope='all',
    personal_project_id=None,
):
    return {
        'id': review_id,
        'personal_space_id': 'personal-space',
        'scope': scope,
        'personal_project_id': personal_project_id,
        'scope_key': (
            f'{scope}:{personal_project_id}' if personal_project_id else scope
        ) + (':tonborg' if reviewer == 'tonborg' else ''),
        'reviewer': reviewer,
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


class TransactionResult:
    def __init__(self, records):
        self.records = records

    def __aiter__(self):
        self._iterator = iter(self.records)
        return self

    async def __anext__(self):
        try:
            return next(self._iterator)
        except StopIteration as error:
            raise StopAsyncIteration from error


class TransactionStub:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []

    async def run(self, query, **parameters):
        self.calls.append((query, parameters))
        return TransactionResult(next(self.responses))


class TransactionRootDriver:
    def __init__(self, transaction):
        self.transaction_value = transaction

    @asynccontextmanager
    async def transaction(self):
        yield self.transaction_value


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
