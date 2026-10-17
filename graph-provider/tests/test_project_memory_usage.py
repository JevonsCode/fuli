from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError
from fastapi import HTTPException

from fuli_graph.project_memory_usage import (
    MemoryUsagePolicy, ProjectMemoryUsageCreate, memory_usage_stats, task_usage_key,
)


NOW = datetime(2026, 10, 18, tzinfo=UTC)


def test_statistics_preserve_exact_aggregates_without_granting_access():
    stats = memory_usage_stats(2, 1, NOW - timedelta(days=1))
    assert stats['totalCount'] == 2
    assert stats['recent30dCount'] == 1
    # A retry does not refresh the original task into a later window.
    assert stats['lastUsedAt'] == NOW - timedelta(days=1)
    assert stats['tier'] == 'related'
    assert stats['grantsAccess'] is False


@pytest.mark.parametrize(('recent', 'tier'), [(0, 'related'), (2, 'related'),
                                                  (3, 'frequent'), (9, 'frequent'), (10, 'close')])
def test_tiers_use_rolling_recent_count_and_reuse_requires_human_confirmation(recent, tier):
    stats = memory_usage_stats(recent + 1, recent, NOW)
    assert stats['tier'] == tier
    assert stats['suggestKnowledgeReuse'] == (tier == 'close')
    assert stats['requiresHumanConfirmation'] is True
    assert stats['grantsAccess'] is False


def test_cutoff_and_configurable_thresholds_are_explicit():
    stats = memory_usage_stats(2, 2, NOW, policy=MemoryUsagePolicy(frequent_min=2, close_min=4))
    assert stats['recent30dCount'] == 2
    assert stats['tier'] == 'frequent'
    with pytest.raises(ValidationError):
        MemoryUsagePolicy(frequent_min=5, close_min=3)


def test_business_task_deduplicates_across_host_contexts_without_storing_tokens():
    one = {'coordination_task_ids': ['real-task']}
    assert task_usage_key(one, 'token-one') == task_usage_key(one, 'token-two')
    assert task_usage_key({}, 'token-one') != task_usage_key({}, 'token-two')
    assert 'token-one' not in task_usage_key({}, 'token-one')
    with pytest.raises(HTTPException, match='task_id'):
        task_usage_key({'coordination_task_ids': ['one', 'two']}, 'token')
    with pytest.raises(HTTPException, match='bound'):
        task_usage_key(one, 'token', task_id='unrelated')


def test_only_completed_result_channels_are_accepted():
    valid = dict(personal_space_id='space', task_context_token='token',
                 source_application='codex', target_project_id='target',
                 evidence_id='answer-id', channel='roundtable_answer', result_count=1)
    assert ProjectMemoryUsageCreate(**valid).result_count == 1
    for changes in [{'channel': 'message_sent'}, {'result_count': -1}, {'result_count': True}]:
        with pytest.raises(ValidationError):
            ProjectMemoryUsageCreate(**{**valid, **changes})
