import copy

import pytest

from fuli_graph.agent_quality_policy import evaluate_quality_policy


def model(tier, cost=1, *, provider='example', name=None, available=True):
    return {'capability_tier': tier, 'cost_rank': cost, 'available': available,
            'provider': provider, 'model': name or f'model-{tier}'}


def attempt(identifier, outcome='fail', tier=1, revision='r1', evidence=True):
    return {'attempt_id': identifier, 'outcome': outcome, 'capability_tier': tier,
            'artifact_revision': revision, 'evidence_refs': [f'check:{identifier}'] if evidence else []}


def evaluate(**overrides):
    return evaluate_quality_policy(**{
        'complexity': 'simple', 'current_strategy': 'adaptive', 'artifact_revision': 'r1',
        'attempts': [], 'available_models': [model(1), model(2), model(3)], **overrides,
    })


@pytest.mark.parametrize(('complexity', 'tier'), [('simple', 1), ('standard', 2), ('complex', 3)])
def test_initial_verification_and_complexity_floor(complexity, tier):
    result = evaluate(complexity=complexity)
    assert result['status'] == 'verification_required'
    assert result['minimum_capability_tier'] == tier
    assert result['selected_model']['capability_tier'] >= tier


@pytest.mark.parametrize(('strategy', 'tier'), [('fast', 1), ('balanced', 2), ('deep', 3)])
def test_strategy_floor_never_undercuts_complexity(strategy, tier):
    assert evaluate(current_strategy={'mode': strategy})['minimum_capability_tier'] == tier
    assert evaluate(complexity='complex', current_strategy=strategy)['minimum_capability_tier'] == 3


def test_existing_higher_capability_is_not_downgraded():
    assert evaluate(current_strategy='fast', current_capability_tier=3)['minimum_capability_tier'] == 3


def test_two_evidenced_failures_escalate_and_revision_changes_do_not_reset_them():
    result = evaluate(artifact_revision='r3', attempts=[attempt('a'), attempt('b', revision='r2')])
    assert result['minimum_capability_tier'] == 2
    assert result['escalation_required']
    assert result['status'] == 'verification_required'


def test_replay_is_deduplicated_and_input_is_not_mutated():
    attempts = [attempt('a'), attempt('a')]
    models = [model(1)]
    original = copy.deepcopy((attempts, models))
    result = evaluate(attempts=attempts, available_models=models)
    assert result['minimum_capability_tier'] == 1
    assert result['attempt_count'] == 1
    result['selected_model']['model'] = 'changed'
    assert (attempts, models) == original


def test_conflicting_replay_is_rejected_even_without_evidence():
    with pytest.raises(ValueError, match='Conflicting attempt_id'):
        evaluate(attempts=[attempt('a', evidence=False), attempt('a', outcome='pass')])


def test_unproven_results_neither_pass_nor_advance_failure_count():
    result = evaluate(attempts=[attempt('a'), attempt('b', evidence=False),
                                attempt('c', outcome='pass', evidence=False)])
    assert result['minimum_capability_tier'] == 1
    assert result['status'] == 'verification_required'
    assert result['ignored_attempt_ids'] == ['b', 'c']


def test_failure_streaks_are_independent_for_each_tier():
    result = evaluate(attempts=[attempt('a', tier=1), attempt('b', tier=2), attempt('c', tier=1)])
    assert result['minimum_capability_tier'] == 2
    assert result['consecutive_failures'] == {1: 2, 2: 1, 3: 0}


def test_evidenced_pass_breaks_only_its_tier_failure_streak():
    result = evaluate(artifact_revision='r2', attempts=[attempt('a'), attempt('b', outcome='pass'), attempt('c')])
    assert result['minimum_capability_tier'] == 1
    assert result['consecutive_failures'][1] == 1
    assert result['status'] == 'verification_required'


def test_current_pass_must_meet_required_tier_and_follow_current_failures():
    assert evaluate(attempts=[attempt('a', outcome='pass')])['status'] == 'passed'
    assert evaluate(complexity='standard', attempts=[attempt('a', outcome='pass')])['status'] == 'verification_required'
    assert evaluate(attempts=[attempt('a', outcome='pass'), attempt('b')])['status'] == 'verification_required'


def test_pass_for_another_revision_does_not_validate_current_artifact():
    assert evaluate(artifact_revision='r2', attempts=[attempt('a', outcome='pass')])['status'] == 'verification_required'


def test_two_failures_at_highest_tier_stop_automatic_retries():
    result = evaluate(attempts=[attempt('a', tier=3), attempt('b', tier=3)])
    assert result['status'] == 'needs_human'
    assert result['minimum_capability_tier'] == 3
    assert result['selected_model'] is None


def test_valid_later_highest_tier_pass_can_resolve_failed_verification():
    result = evaluate(attempts=[attempt('a', tier=3), attempt('b', tier=3), attempt('c', outcome='pass', tier=3)])
    assert result['status'] == 'passed'


def test_stale_pass_cannot_release_highest_tier_human_gate():
    result = evaluate(artifact_revision='current', attempts=[
        attempt('a', tier=3), attempt('b', tier=3),
        attempt('c', outcome='pass', tier=3, revision='old'),
    ])
    assert result['status'] == 'needs_human'


def test_more_failures_at_the_same_tier_do_not_skip_a_capability_level():
    result = evaluate(attempts=[attempt('a'), attempt('b'), attempt('c'), attempt('d')])
    assert result['minimum_capability_tier'] == 2
    assert result['escalation_attempt_ids'] == ['b']


def test_actual_higher_tier_attempt_prevents_downgrade():
    result = evaluate(attempts=[attempt('a', tier=3)])
    assert result['minimum_capability_tier'] == 3


def test_escalation_floor_survives_later_low_tier_pass():
    result = evaluate(attempts=[attempt('a'), attempt('b'), attempt('c', outcome='pass')])
    assert result['minimum_capability_tier'] == 2
    assert result['status'] == 'verification_required'


def test_no_observed_available_qualified_model_blocks_instead_of_claiming_upgrade():
    result = evaluate(attempts=[attempt('a'), attempt('b')], available_models=[
        model(1), model(None, 0), model('unknown', 0), model(3, 0, available=False),
    ])
    assert result['minimum_capability_tier'] == 2
    assert result['status'] == 'blocked'
    assert result['selected_model'] is None


def test_cheapest_qualified_model_with_stable_tie_breaking():
    models = [model(1, 0), model(2, 5), model(3, 2, provider='z'), model(2, 2, provider='a', name='z'),
              model(3, 2, provider='a', name='a')]
    expected = {'capability_tier': 3, 'cost_rank': 2, 'available': True, 'provider': 'a', 'model': 'a'}
    assert evaluate(complexity='standard', available_models=models)['selected_model'] == expected
    assert evaluate(complexity='standard', available_models=list(reversed(models)))['selected_model'] == expected


def test_verified_result_does_not_require_an_available_execution_model():
    assert evaluate(attempts=[attempt('a', outcome='pass')], available_models=[])['status'] == 'passed'


@pytest.mark.parametrize('cost', [float('nan'), float('inf'), -1, True, 'cheap', None])
def test_unusable_cost_metadata_never_wins_selection(cost):
    result = evaluate(available_models=[model(1, cost)])
    assert result['status'] == 'blocked'


def test_arbitrarily_large_nonnegative_integer_rank_is_supported():
    assert evaluate(available_models=[model(1, 10 ** 1000)])['status'] == 'verification_required'


@pytest.mark.parametrize('overrides', [
    {'complexity': 'unknown'}, {'current_strategy': 'unknown'}, {'current_capability_tier': 4},
    {'artifact_revision': ''}, {'attempts': [attempt('a', tier=0)]},
    {'attempts': [{**attempt('a'), 'outcome': 'maybe'}]},
    {'attempts': [{**attempt('a'), 'evidence_refs': 'not-a-list'}]},
])
def test_invalid_contract_values_are_rejected(overrides):
    with pytest.raises(ValueError):
        evaluate(**overrides)
