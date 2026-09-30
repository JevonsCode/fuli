"""Deterministic quality gate and capability routing, without I/O or model calls.

The caller owns trusted evidence collection and persists ordered attempts. A
selected model is only a recommendation: selection never proves execution or
successful verification. Artifact revisions must identify the checked artifact.
"""
from collections.abc import Mapping
from copy import deepcopy
from math import isfinite


COMPLEXITY_TIERS = {'simple': 1, 'standard': 2, 'complex': 3}
STRATEGY_TIERS = {'fast': 1, 'balanced': 2, 'deep': 3, 'adaptive': 1}


def _tier(value):
    return type(value) is int and 1 <= value <= 3


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _unique_attempts(attempts):
    seen = {}
    unique = []
    for attempt in attempts:
        if not isinstance(attempt, Mapping):
            raise ValueError('Each verification attempt must be an object')
        identifier = attempt.get('attempt_id')
        refs = attempt.get('evidence_refs')
        if not _text(identifier) or not _text(attempt.get('artifact_revision')):
            raise ValueError('attempt_id and artifact_revision must be nonempty strings')
        if attempt.get('outcome') not in ('pass', 'fail'):
            raise ValueError('Attempt outcome must be pass or fail')
        if not _tier(attempt.get('capability_tier')):
            raise ValueError('Attempt capability_tier must be an observed integer from 1 to 3')
        if not isinstance(refs, (list, tuple)) or not all(_text(ref) for ref in refs):
            raise ValueError('evidence_refs must contain nonempty string references')
        if identifier in seen:
            if seen[identifier] != attempt:
                raise ValueError(f'Conflicting attempt_id: {identifier}')
            continue
        seen[identifier] = attempt
        unique.append(attempt)
    return unique


def _select_model(models, minimum):
    eligible = []
    for model in models:
        if not isinstance(model, Mapping):
            continue
        tier, cost = model.get('capability_tier'), model.get('cost_rank')
        if model.get('available') is not True or not _tier(tier) or tier < minimum:
            continue
        if type(cost) not in (int, float) or cost < 0:
            continue
        if type(cost) is float and not isfinite(cost):
            continue
        if not _text(model.get('provider')) or not _text(model.get('model')):
            continue
        eligible.append(model)
    if not eligible:
        return None
    selected = min(eligible, key=lambda item: (
        item['cost_rank'], item['provider'], item['model'], -item['capability_tier'],
    ))
    # Return only routing metadata, detached from the caller's mutable catalog.
    return deepcopy({key: selected[key] for key in (
        'provider', 'model', 'capability_tier', 'cost_rank', 'available',
    )})


def evaluate_quality_policy(*, complexity, current_strategy, artifact_revision,
                            attempts=(), available_models=(), current_capability_tier=None):
    """Return a quality gate and the cheapest observed model meeting its floor.

    ``current_strategy`` is a mode string or a mapping containing ``mode``.
    Unproven attempts are retained in the count but cannot pass the gate, reset
    failure streaks, or trigger escalation. Distinct evidence-backed failures
    accumulate per capability tier across artifact revisions. A proved pass
    resets its tier's streak, without erasing an already-earned capability floor.

    Status is one of ``verification_required``, ``passed``, ``needs_human``, or
    ``blocked``. Two failures at tier 3 stop automatic selection. A later valid
    tier-3 pass can resolve that gate, for example after human-directed repair.
    ``escalation_required`` means the floor rose above the declared current
    capability; it does not mean an upgraded executor has already run.
    """
    mode = current_strategy.get('mode') if isinstance(current_strategy, Mapping) else current_strategy
    if not isinstance(complexity, str) or complexity not in COMPLEXITY_TIERS:
        raise ValueError('Unknown task complexity')
    if not isinstance(mode, str) or mode not in STRATEGY_TIERS:
        raise ValueError('Unknown model strategy')
    if not _text(artifact_revision):
        raise ValueError('artifact_revision must be a nonempty string')
    if current_capability_tier is not None and not _tier(current_capability_tier):
        raise ValueError('current_capability_tier must be an integer from 1 to 3')
    declared_tier = max(STRATEGY_TIERS[mode], current_capability_tier or 1)
    minimum = max(COMPLEXITY_TIERS[complexity], declared_tier)
    consecutive = {1: 0, 2: 0, 3: 0}
    unique = _unique_attempts(attempts)
    ignored = []
    last_current = None
    escalation_attempt_ids = []
    needs_human = False
    for attempt in unique:
        if not attempt['evidence_refs']:
            ignored.append(attempt['attempt_id'])
            continue
        tier = attempt['capability_tier']
        # Evidence that a higher tier already ran prevents a silent downgrade.
        minimum = max(minimum, tier)
        if attempt['outcome'] == 'fail':
            consecutive[tier] += 1
            if consecutive[tier] == 2:
                minimum = max(minimum, min(3, tier + 1))
                escalation_attempt_ids.append(attempt['attempt_id'])
                if tier == 3:
                    needs_human = True
        else:
            consecutive[tier] = 0
            if tier == 3 and attempt['artifact_revision'] == artifact_revision:
                needs_human = False
        if attempt['artifact_revision'] == artifact_revision:
            last_current = attempt

    result = {
        'status': 'verification_required',
        'minimum_capability_tier': minimum,
        'escalation_required': minimum > declared_tier,
        'selected_model': None,
        'artifact_revision': artifact_revision,
        'verified_attempt_id': None,
        'attempt_count': len(unique),
        'ignored_attempt_ids': ignored,
        'consecutive_failures': consecutive,
        'escalation_attempt_ids': escalation_attempt_ids,
    }
    if needs_human:
        result['status'] = 'needs_human'
    elif (last_current is not None and last_current['outcome'] == 'pass'
          and last_current['capability_tier'] >= minimum):
        result['status'] = 'passed'
        result['verified_attempt_id'] = last_current['attempt_id']
    else:
        result['selected_model'] = _select_model(available_models, minimum)
        if result['selected_model'] is None:
            result['status'] = 'blocked'
    return result
