"""Deterministic, zero-token Agent score card from already recorded outcomes.

Every dimension stands alone with its own sample; nothing is combined into a
total and no model is called. Below the minimum sample a dimension reports
数据不足 and no conclusion, so missing, unreported or idle work never counts
against an Agent. A tier is a display label carried with its evidence count and
is never a basis for an automatic action.

The executor-learning buckets decide which outcome evidence currently counts
(after the user's ignores and resets); their evidence records supply the task.
"""

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone

from .project_agent_executor_models import MINIMUM_EVIDENCE_SAMPLES
from .project_agent_score_card_models import (
    ProjectAgentScoreDimension,
    ProjectAgentScoreDimensions,
    ProjectAgentScoreExecutor,
    ProjectAgentScoreTaskList,
    ProjectAgentScoreTier,
    ProjectAgentToolFlag,
)


DIMENSIONS = ('completion', 'first_pass', 'user_feedback', 'review')
INSUFFICIENT_DATA_LABEL = '数据不足'
_TIER_FLOORS = ((0.9, 'S'), (0.75, 'A'), (0.5, 'B'), (0.0, 'C'))
_WEAK_TIER = 'C'
_STRONG_TIERS = frozenset({'S', 'A'})
_RATE_DIGITS = 3
_COUNTED_TERMINAL_OUTCOMES = frozenset({'completed', 'failed'})
_FEEDBACK_KINDS = frozenset({'explicit_praise', 'repeated_negative_feedback', 'explicit_rating'})
_REVIEW_OUTCOMES = {'test_passed': True, 'acceptance_passed': True,
                    'test_failed': False, 'acceptance_failed': False}
_POSITIVE_RATING = 4
_NEGATIVE_RATING = 2
_UNDATED = datetime.min.replace(tzinfo=timezone.utc)


@dataclass(frozen=True)
class ScoreFact:
    """One counted observation: a task passed or did not pass one dimension."""

    dimension: str
    personal_project_id: str
    executor_id: str | None
    task_id: str
    passed: bool
    occurred_at: datetime | None


def outcome_score_facts(aggregates, evidence_records) -> list[ScoreFact]:
    """Classify the evidence the learning buckets count, per executor and task.

    Completion is the latest completed/failed run of a task; a cancelled run is
    neutral. First pass is a completed task with no rework request and no
    earlier failed run. A bucket with validation warnings is neutral as a whole.
    """
    records = {record.evidence_id: record for record in evidence_records}
    runs = defaultdict(list)
    reworked = set()
    facts = []
    for aggregate in aggregates:
        if aggregate.validation_warnings:
            continue
        for contribution in aggregate.evidence_contributions:
            record = records.get(contribution.evidence_id)
            if record is None:
                continue
            key = (record.personal_project_id, record.executor_id, record.task_id)
            kind = record.evidence_kind
            if kind == 'terminal_outcome':
                if record.terminal_outcome in _COUNTED_TERMINAL_OUTCOMES:
                    runs[key].append((record.occurred_at, record.terminal_outcome))
            elif kind == 'rework_requested':
                reworked.add(key)
            elif kind in _FEEDBACK_KINDS:
                positive = _feedback_polarity(record)
                if positive is not None:
                    facts.append(ScoreFact('user_feedback', *key, positive, record.occurred_at))
            elif kind in _REVIEW_OUTCOMES:
                facts.append(ScoreFact('review', *key, _REVIEW_OUTCOMES[kind], record.occurred_at))
    for key, outcomes in runs.items():
        occurred_at, latest = max(outcomes)
        facts.append(ScoreFact('completion', *key, latest == 'completed', occurred_at))
        if latest == 'completed':
            first_pass = key not in reworked and all(outcome == 'completed' for _, outcome in outcomes)
            facts.append(ScoreFact('first_pass', *key, first_pass, occurred_at))
    return facts


def review_verdict_facts(verdicts, participant_projects) -> tuple[list[ScoreFact], int]:
    """Host review verdicts count only for a task this Agent worked in that project."""
    facts, disputed = [], 0
    for verdict in verdicts:
        if participant_projects.get(verdict.task_id) != verdict.personal_project_id:
            continue
        if verdict.result == 'disputed':
            disputed += 1
            continue
        facts.append(ScoreFact('review', verdict.personal_project_id, None, verdict.task_id,
                               verdict.result == 'passed', verdict.occurred_at))
    return facts, disputed


def score_card_sections(facts) -> dict:
    """Dimensions, the executors behind them and tool flags; never a total."""
    by_dimension = _group(facts, lambda fact: fact.dimension)
    executors = Counter(fact.executor_id for fact in facts if fact.executor_id)
    return {
        'minimum_sample': MINIMUM_EVIDENCE_SAMPLES,
        'dimensions': ProjectAgentScoreDimensions(**{
            name: _dimension(by_dimension.get(name, [])) for name in DIMENSIONS}),
        'executors': [ProjectAgentScoreExecutor(executor_id=executor_id, evidence_count=count)
                      for executor_id, count in sorted(executors.items())],
        'tool_flags': [flag for name in DIMENSIONS for flag in _tool_flags(name, by_dimension.get(name, []))],
    }


def score_evidence_sections(facts, *, dimension, executor_id, limit) -> dict:
    """The tasks behind one dimension (optionally one executor), newest first."""
    selected = [fact for fact in facts if fact.dimension == dimension
                and (executor_id is None or fact.executor_id == executor_id)]
    selected.sort(key=lambda fact: fact.task_id)
    selected.sort(key=lambda fact: fact.occurred_at or _UNDATED, reverse=True)
    passed = _task_list([fact for fact in selected if fact.passed], limit)
    not_passed = _task_list([fact for fact in selected if not fact.passed], limit)
    return {'passed': passed[0], 'not_passed': not_passed[0], 'truncated': passed[1] or not_passed[1]}


def _feedback_polarity(record) -> bool | None:
    if record.evidence_kind == 'explicit_praise':
        return True
    if record.evidence_kind == 'repeated_negative_feedback':
        return False
    if record.rating >= _POSITIVE_RATING:
        return True
    if record.rating <= _NEGATIVE_RATING:
        return False
    return None


def _dimension(facts) -> ProjectAgentScoreDimension:
    sample = len(facts)
    if sample < MINIMUM_EVIDENCE_SAMPLES:
        return ProjectAgentScoreDimension(
            status='insufficient_data', sample=sample, label=INSUFFICIENT_DATA_LABEL)
    passed = sum(fact.passed for fact in facts)
    rate = passed / sample
    return ProjectAgentScoreDimension(
        status='scored', sample=sample, passed=passed, rate=round(rate, _RATE_DIGITS),
        tier=ProjectAgentScoreTier(label=_tier(rate), evidence_count=sample))


def _tier(rate: float) -> str:
    return next(label for floor, label in _TIER_FLOORS if rate >= floor)


def _tool_flags(dimension, facts) -> list[ProjectAgentToolFlag]:
    scored = {executor_id: value for executor_id, group in _group(
        [fact for fact in facts if fact.executor_id], lambda fact: fact.executor_id).items()
        if (value := _dimension(group)).status == 'scored'}
    strong = sorted((executor_id for executor_id, value in scored.items() if value.tier.label in _STRONG_TIERS),
                    key=lambda executor_id: (-scored[executor_id].rate, -scored[executor_id].sample, executor_id))
    if not strong:
        return []
    compared = scored[strong[0]]
    return [ProjectAgentToolFlag(
        dimension=dimension, executor_id=executor_id, rate=value.rate, sample=value.sample,
        compared_executor_id=strong[0], compared_rate=compared.rate, compared_sample=compared.sample,
    ) for executor_id, value in sorted(scored.items()) if value.tier.label == _WEAK_TIER]


def _task_list(facts, limit) -> tuple[ProjectAgentScoreTaskList, bool]:
    task_ids = list(dict.fromkeys(fact.task_id for fact in facts))
    return ProjectAgentScoreTaskList(count=len(facts), task_ids=task_ids[:limit]), len(task_ids) > limit


def _group(facts, key):
    groups = defaultdict(list)
    for fact in facts:
        groups[key(fact)].append(fact)
    return groups
