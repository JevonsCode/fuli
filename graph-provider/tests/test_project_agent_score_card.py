"""Bole's zero-token score card, read through the Provider HTTP routes."""

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Annotated

import httpx
import pytest
from fastapi import Depends, FastAPI, HTTPException

from fuli_graph.project_agent_executor_models import (
    ProjectAgentExecutorEvidenceContribution,
    ProjectAgentExecutorOutcomeAggregate,
    project_agent_model_strategy_key,
)
from fuli_graph.project_agent_models import ProjectAgentModelStrategy
from fuli_graph.project_agent_score_card_routes import register_project_agent_score_card_routes
from fuli_graph.store_project_agent_executor_learning import StoreProjectAgentExecutorLearning
from fuli_graph.store_project_agent_score_card import StoreProjectAgentScoreCard


UTC = timezone.utc
NOW = datetime(2026, 10, 20, 12, tzinfo=UTC)
STRATEGY = ProjectAgentModelStrategy()
STRATEGY_KEY = project_agent_model_strategy_key(STRATEGY)
WRITE_CLAUSES = ('MERGE ', 'CREATE ', 'SET ', 'DELETE ', 'REMOVE ')
SOURCES = {'terminal_outcome': 'system_terminal', 'test_passed': 'test_fact', 'test_failed': 'test_fact'}
SIGNALS = {'rework_requested': 'rework', 'explicit_rating': 'rating', 'explicit_praise': 'success',
           'test_passed': 'success', 'acceptance_passed': 'success'}


class NoModel:
    """Any model or LLM access on the Provider runtime fails the test."""

    def __getattr__(self, name):
        raise AssertionError(f'score card touched a model client: {name}')


def evidence(task_id, kind, *, days_ago=1, executor='executor-a', project='project-1',
             agent='agent-1', outcome=None, rating=None, counted=True, evidence_id=None):
    occurred = NOW - timedelta(days=days_ago)
    return {
        'evidence_id': evidence_id or f'{task_id}:{kind}:{outcome or rating or ""}:{days_ago}',
        'personal_space_id': 'space-1', 'personal_project_id': project, 'work_kind': 'review',
        'agent_id': agent, 'executor_id': executor, 'task_id': task_id, 'run_id': f'run-{task_id}',
        'model_strategy_json': STRATEGY.model_dump_json(), 'model_strategy_key': STRATEGY_KEY,
        'evidence_kind': kind, 'source': SOURCES.get(kind, 'user_explicit'),
        'terminal_outcome': outcome, 'rating': rating, 'reference_ids': [f'ref-{task_id}'],
        'occurred_at': occurred, 'created_at': occurred, 'ignored': False,
        # Fixture-only: evidence the learning bucket no longer counts (ignored
        # or before a reset) stays readable but is absent from contributions.
        '_counted': counted,
    }


def completed(task_id, **options):
    return evidence(task_id, 'terminal_outcome', outcome='completed', **options)


def failed(task_id, **options):
    return evidence(task_id, 'terminal_outcome', outcome='failed', **options)


def signal(item):
    if item['evidence_kind'] == 'terminal_outcome':
        return {'completed': 'success', 'failed': 'failure'}.get(item['terminal_outcome'], 'neutral')
    return SIGNALS.get(item['evidence_kind'], 'failure')


def aggregates_for(items, *, warnings_for=()):
    """The learning buckets as the executor-learning store persists them."""
    buckets = defaultdict(list)
    for item in items:
        buckets[(item['personal_project_id'], item['agent_id'], item['executor_id'])].append(item)
    result = []
    for (project, agent, executor), bucket in buckets.items():
        counted = [item for item in bucket if item['_counted']]
        result.append(ProjectAgentExecutorOutcomeAggregate(
            personal_space_id='space-1', personal_project_id=project, work_kind='review',
            agent_id=agent, executor_id=executor, model_strategy=STRATEGY,
            model_strategy_key=STRATEGY_KEY, sample_count=len(counted), recent_count=0,
            success_count=0, rework_count=0, failure_count=0, rating_count=0,
            as_of=NOW, decay_half_life_days=30, weighted_success=0, weighted_failure=0,
            validation_warnings=['evidence_timestamp_timezone_missing:x'] if executor in warnings_for else [],
            evidence_contributions=[ProjectAgentExecutorEvidenceContribution(
                evidence_id=item['evidence_id'], evidence_kind=item['evidence_kind'],
                signal=signal(item), value=1.0, decay_weight=1.0,
                occurred_at=item['occurred_at'], reference_ids=item['reference_ids'],
            ) for item in counted],
        ))
    return result


class ScoreCardDriver:
    """Answers the score card's reads by query shape and refuses any write."""

    def __init__(self, items, *, projects=('project-1', 'project-2'), participants=None, warnings_for=()):
        self.items = items
        self.aggregates = aggregates_for(items, warnings_for=warnings_for)
        self.projects = set(projects)
        self.participants = participants or {}
        self.queries = []

    async def execute_query(self, query, **parameters):
        self.queries.append(query)
        if 'CONTAINS_PROJECT' in query:
            found = parameters['project_id'] in self.projects
            return ([{'project': {'project_id': parameters['project_id']}}] if found else []), None, None
        if 'MATCH (aggregate:FuliProjectAgentExecutorOutcomeAggregate' in query:
            return [{'aggregate': {'aggregate_json': aggregate.model_dump_json()}}
                    for aggregate in self.aggregates
                    if aggregate.agent_id == parameters['agent_id']
                    and parameters['personal_project_id'] in {None, aggregate.personal_project_id}], None, None
        if 'MATCH (evidence:FuliProjectAgentExecutorOutcomeEvidence' in query:
            return [{'evidence': {key: value for key, value in item.items() if key != '_counted'}}
                    for item in self.items
                    if item['personal_project_id'] == parameters['personal_project_id']
                    and item['agent_id'] == parameters['agent_id']], None, None
        if 'HAS_PARTICIPANT' in query:
            tasks = self.participants.get(parameters['agent_id'], {})
            return [{'task_id': task_id, **state}
                    for task_id, state in tasks.items() if task_id in parameters['task_ids']], None, None
        raise AssertionError(f'unexpected score card query: {query}')


def task_state(project='project-1', *, verified='artifact-1', attempt='attempt-1', observed='artifact-1'):
    """A task the Agent worked on, with its current verification and newest observed artifact."""
    return {'personal_project_id': project, 'verified_artifact_revision': verified,
            'verified_attempt_id': attempt, 'current_artifact_revision': observed}


def verdict(task_id, result, *, project='project-1', artifact='artifact-1', attempt='attempt-1'):
    """A Tonborg verdict with the artifact and verification attempt it judged."""
    return {'task_id': task_id, 'personal_project_id': project, 'result': result,
            'artifact_revision': artifact, 'verification_attempt_id': attempt}


class ScoreCardStore(StoreProjectAgentScoreCard, StoreProjectAgentExecutorLearning):
    def __init__(self, driver):
        self.runtime = SimpleNamespace(driver=driver, graphiti=NoModel())
        self.settings = SimpleNamespace(provider_mode='personal', provider_id='provider-1')

    def _require_personal(self):
        return None

    async def authorize(self, actor, space_id, role):
        assert role == 'reader', 'the score card is a read'
        if actor['id'] != 'principal-1' or space_id != 'space-1':
            raise HTTPException(status_code=403, detail='space access denied')
        return {'id': space_id, 'kind': 'personal'}


async def post(driver, path, **body):
    async def actor():
        return {'id': 'principal-1'}

    app = FastAPI()
    register_project_agent_score_card_routes(app, ScoreCardStore(driver), Annotated[dict, Depends(actor)])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://fixture') as client:
        return await client.post(path, json={'personal_space_id': 'space-1', 'agent_id': 'agent-1', **body})


async def card(driver, **body):
    response = await post(driver, '/v1/project-agent-score-card/query', **body)
    assert response.status_code == 200, response.text
    return response.json()


async def drill(driver, dimension, **body):
    response = await post(driver, '/v1/project-agent-score-card/evidence', dimension=dimension, **body)
    assert response.status_code == 200, response.text
    return response.json()


def worked_example():
    return [
        completed('task-1', days_ago=5),
        evidence('task-1', 'explicit_praise', days_ago=5),
        evidence('task-1', 'test_passed', days_ago=5),
        completed('task-2', days_ago=4),
        evidence('task-2', 'rework_requested', days_ago=3),
        evidence('task-2', 'explicit_rating', rating=5, days_ago=3),
        evidence('task-2', 'acceptance_passed', days_ago=3),
        failed('task-3', days_ago=6),
        completed('task-3', days_ago=2),
        evidence('task-3', 'explicit_rating', rating=3, days_ago=2),
        failed('task-4', days_ago=1),
        evidence('task-4', 'repeated_negative_feedback', days_ago=1),
        evidence('task-4', 'explicit_rating', rating=1, days_ago=1),
        evidence('task-4', 'acceptance_failed', days_ago=1),
        evidence('task-5', 'terminal_outcome', outcome='cancelled', days_ago=1),
        completed('task-6', counted=False),  # ignored by the user: still history, never a score
        failed('task-z1', executor='executor-z'),
        failed('task-z2', executor='executor-z'),
        failed('task-z3', executor='executor-z'),
    ]


@pytest.mark.asyncio
async def test_each_dimension_comes_from_recorded_outcomes_with_its_own_sample_and_no_total():
    driver = ScoreCardDriver(worked_example(), warnings_for={'executor-z'})
    result = await card(driver)

    dimensions = result['dimensions']
    assert set(dimensions) == {'completion', 'first_pass', 'user_feedback', 'review'}
    # Latest terminal outcome per task: 1, 2 and 3 completed; 4 failed. A
    # cancelled run, an ignored item and an unusable bucket are not evidence.
    assert dimensions['completion'] | {'tier': None} == {
        'status': 'scored', 'sample': 4, 'passed': 3, 'rate': 0.75, 'tier': None, 'label': None}
    # Only task 1 completed without a rework request or an earlier failure.
    assert (dimensions['first_pass']['passed'], dimensions['first_pass']['sample']) == (1, 3)
    # Praise and 5 are positive; negative feedback and 1 are negative; 3 is neutral.
    assert (dimensions['user_feedback']['passed'], dimensions['user_feedback']['sample']) == (2, 4)
    # Test and user acceptance verdicts recorded with the outcomes.
    assert (dimensions['review']['passed'], dimensions['review']['sample']) == (2, 3)
    assert not {'total', 'overall', 'score'} & set(result)
    assert result['executors'] == [{'executor_id': 'executor-a', 'evidence_count': 14}]
    assert result['tool_flags'] == []
    assert result['minimum_sample'] == 3
    assert result['personal_project_ids'] is None


@pytest.mark.asyncio
async def test_below_the_minimum_sample_a_dimension_says_data_insufficient_and_concludes_nothing():
    driver = ScoreCardDriver([completed('task-1'), failed('task-2')])
    result = await card(driver)

    assert result['dimensions']['completion'] == {
        'status': 'insufficient_data', 'sample': 2, 'passed': None, 'rate': None, 'tier': None, 'label': '数据不足'}
    idle = await card(ScoreCardDriver([]))
    for dimension in idle['dimensions'].values():
        assert dimension == {'status': 'insufficient_data', 'sample': 0, 'passed': None,
                             'rate': None, 'tier': None, 'label': '数据不足'}
    assert idle['tool_flags'] == [] and idle['executors'] == []


@pytest.mark.asyncio
async def test_weakness_on_only_one_executor_is_flagged_as_a_tool_problem():
    good = [completed(f'a-{index}', executor='executor-a') for index in range(4)]
    weak = [failed(f'b-{index}', executor='executor-b') for index in range(4)]
    result = await card(ScoreCardDriver(good + weak))

    assert result['tool_flags'] == [{
        'dimension': 'completion', 'executor_id': 'executor-b', 'rate': 0.0, 'sample': 4,
        'compared_executor_id': 'executor-a', 'compared_rate': 1.0, 'compared_sample': 4,
        'suggestion': 'change_executor_or_model',
    }]
    everywhere = [failed(f'a-{index}', executor='executor-a') for index in range(4)]
    assert (await card(ScoreCardDriver(everywhere + weak)))['tool_flags'] == [], \
        'poor results on every executor are not a tool problem'
    too_few = [failed(f'b-{index}', executor='executor-b') for index in range(2)]
    assert (await card(ScoreCardDriver(good + too_few)))['tool_flags'] == [], \
        'an executor below the minimum sample gets no conclusion either way'


@pytest.mark.asyncio
async def test_a_task_retried_on_another_executor_is_one_task_and_never_a_first_pass():
    """Review of #232: three tasks that failed on A and then completed on B."""
    items = []
    for index in range(3):
        items += [failed(f'task-{index}', executor='executor-a', days_ago=3),
                  completed(f'task-{index}', executor='executor-b', days_ago=1)]
    driver = ScoreCardDriver(items)
    result = await card(driver)

    completion, first_pass = result['dimensions']['completion'], result['dimensions']['first_pass']
    assert (completion['passed'], completion['sample'], completion['rate']) == (3, 3, 1.0)
    assert (first_pass['passed'], first_pass['sample'], first_pass['rate']) == (0, 3, 0.0)
    tasks = ['task-0', 'task-1', 'task-2']
    by_task = await drill(driver, 'completion')
    assert (sorted(by_task['passed']['task_ids']), by_task['not_passed']) == (tasks, {'count': 0, 'task_ids': []})
    assert sorted((await drill(driver, 'first_pass'))['not_passed']['task_ids']) == tasks

    # The executor view is a separate diagnosis: A failed every run, B finished
    # every task it took over. It never feeds the task-level dimensions.
    assert result['tool_flags'] == [{
        'dimension': 'completion', 'executor_id': 'executor-a', 'rate': 0.0, 'sample': 3,
        'compared_executor_id': 'executor-b', 'compared_rate': 1.0, 'compared_sample': 3,
        'suggestion': 'change_executor_or_model',
    }]
    on_a = await drill(driver, 'completion', executor_id='executor-a')
    assert (on_a['passed']['count'], sorted(on_a['not_passed']['task_ids'])) == (0, tasks)


@pytest.mark.asyncio
async def test_a_tonborg_verdict_counts_only_while_its_artifact_and_verification_are_current():
    items = [completed(f'task-{index}') for index in range(5)]
    participants = {'agent-1': {
        'task-0': task_state(),
        'task-1': task_state(verified='artifact-2', attempt=None, observed='artifact-2'),  # new artifact failed verification
        'task-2': task_state(attempt='attempt-2'),  # re-verified by another attempt
        'task-3': task_state(observed='artifact-3'),  # a newer artifact is not verified yet
        'task-4': task_state(verified=None, attempt=None, observed=None),  # no verification recorded
    }}
    verdicts = [verdict(f'task-{index}', 'passed') for index in range(5)] + [verdict('task-1', 'disputed')]
    driver = ScoreCardDriver(items, participants=participants)
    result = await card(driver, review_verdicts=verdicts)

    assert result['dimensions']['review']['sample'] == 1
    assert (result['stale_review_count'], result['disputed_review_count']) == (5, 0)
    review = await drill(driver, 'review', review_verdicts=verdicts)
    assert review['passed']['task_ids'] == ['task-0']
    missing_version = await post(driver, '/v1/project-agent-score-card/query', review_verdicts=[
        {'task_id': 'task-0', 'personal_project_id': 'project-1', 'result': 'passed'}])
    assert missing_version.status_code == 422, 'a verdict without its evidence version cannot be checked'


@pytest.mark.asyncio
async def test_a_tier_is_only_a_label_and_always_carries_its_evidence_count():
    driver = ScoreCardDriver(worked_example(), warnings_for={'executor-z'})
    dimensions = (await card(driver))['dimensions']

    tiers = {name: value['tier'] for name, value in dimensions.items()}
    assert tiers == {
        'completion': {'label': 'A', 'evidence_count': 4},
        'first_pass': {'label': 'C', 'evidence_count': 3},
        'user_feedback': {'label': 'B', 'evidence_count': 4},
        'review': {'label': 'B', 'evidence_count': 3},
    }
    assert all(value['tier']['evidence_count'] == value['sample'] for value in dimensions.values())


@pytest.mark.asyncio
async def test_evidence_drill_down_returns_the_task_ids_behind_one_dimension():
    driver = ScoreCardDriver(worked_example(), warnings_for={'executor-z'})

    completion = await drill(driver, 'completion')
    assert completion['passed'] == {'count': 3, 'task_ids': ['task-3', 'task-2', 'task-1']}
    assert completion['not_passed'] == {'count': 1, 'task_ids': ['task-4']}
    first_pass = await drill(driver, 'first_pass', executor_id='executor-a')
    assert first_pass['passed'] == {'count': 1, 'task_ids': ['task-1']}
    assert first_pass['not_passed'] == {'count': 2, 'task_ids': ['task-3', 'task-2']}
    limited = await drill(driver, 'completion', limit=1)
    assert limited['passed'] == {'count': 3, 'task_ids': ['task-3']} and limited['truncated'] is True
    other = await drill(driver, 'completion', executor_id='executor-b')
    assert other['passed'] == {'count': 0, 'task_ids': []} and other['truncated'] is False


@pytest.mark.asyncio
async def test_host_review_verdicts_count_only_for_tasks_the_agent_worked_and_disputes_never_count():
    items = [completed('task-1'), completed('task-2'), completed('task-3')]
    participants = {'agent-1': {'task-1': task_state(), 'task-2': task_state(), 'task-3': task_state()},
                    'agent-2': {'task-9': task_state()}}
    verdicts = [
        verdict('task-1', 'passed'),
        verdict('task-2', 'not_passed'),
        verdict('task-3', 'passed'),
        verdict('task-3', 'disputed'),
        verdict('task-9', 'passed'),  # someone else's task
        verdict('task-1', 'passed', project='project-2'),  # wrong project
    ]
    driver = ScoreCardDriver(items, participants=participants)
    result = await card(driver, review_verdicts=verdicts)

    assert result['dimensions']['review'] | {'tier': None} == {
        'status': 'scored', 'sample': 3, 'passed': 2, 'rate': 0.667, 'tier': None, 'label': None}
    assert (result['disputed_review_count'], result['stale_review_count']) == (1, 0)
    review = await drill(driver, 'review', review_verdicts=verdicts)
    assert sorted(review['passed']['task_ids']) == ['task-1', 'task-3']
    assert review['not_passed']['task_ids'] == ['task-2']


@pytest.mark.asyncio
async def test_score_card_and_drill_down_stay_inside_authorized_projects():
    items = [completed(f'one-{index}') for index in range(3)] + \
        [failed(f'two-{index}', project='project-2') for index in range(3)]
    participants = {'agent-1': {'two-0': task_state('project-2')}}
    driver = ScoreCardDriver(items, participants=participants)

    assert (await card(driver))['dimensions']['completion']['sample'] == 6
    scoped = await card(driver, personal_project_ids=['project-1'],
                        review_verdicts=[verdict('two-0', 'passed', project='project-2')])
    assert scoped['personal_project_ids'] == ['project-1']
    assert scoped['dimensions']['completion']['passed'] == 3
    assert scoped['dimensions']['review']['sample'] == 0
    evidence_ids = await drill(driver, 'completion', personal_project_ids=['project-1'])
    assert evidence_ids['not_passed']['task_ids'] == []
    assert sorted(evidence_ids['passed']['task_ids']) == ['one-0', 'one-1', 'one-2']
    assert (await card(driver, personal_project_ids=[]))['dimensions']['completion']['sample'] == 0

    missing = await post(driver, '/v1/project-agent-score-card/query', personal_project_ids=['project-x'])
    assert missing.status_code == 404
    hidden = await post(driver, '/v1/project-agent-score-card/evidence', dimension='completion',
                        personal_project_ids=['project-x'])
    assert hidden.status_code == 404
    other_space = await post(driver, '/v1/project-agent-score-card/query', personal_space_id='space-2')
    assert other_space.status_code == 403


@pytest.mark.asyncio
async def test_score_card_is_a_pure_read_that_calls_no_model():
    driver = ScoreCardDriver(worked_example(), warnings_for={'executor-z'})
    await card(driver)
    await drill(driver, 'review')

    assert driver.queries, 'the card reads recorded outcomes'
    assert not [query for query in driver.queries if any(clause in query for clause in WRITE_CLAUSES)]
