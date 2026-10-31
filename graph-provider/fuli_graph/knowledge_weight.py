"""The one knowledge weight: what the console and receipts show, search ranks by
and the review queue calls low.

The weight is derived on read from stored, auditable facts; nothing stores it.
Confirmation sets the band: a person's or authoritative source's confirmation is
1.0, usage confirmation 0.70-0.95, pending 0.10-0.69, so an otherwise equal item
never outranks one with stronger confirmation. Within a band, evidence moves it:
qualified use (cited or applied) and distinct tasks, fading with time since the
last use, plus real sources; each negative feedback takes some away. An item
flagged for attention is halved, whatever its band. The weight never grants
authority: confirmation_status alone decides retrieval, conflicts and promotion.
"""
from datetime import datetime, timezone

from .models import _validate_confirmation_state, stored_confirmation_basis
from .provider_values import native_datetime

PENDING_BAND = (10, 69)
AGENT_CONFIRMED_BAND = (70, 95)
CONFIRMED_PERCENT = 100
USE_POINTS, USE_CAP = 2, 50
TASK_POINTS, TASK_CAP = 5, 25
SOURCE_POINTS, SOURCE_CAP = 5, 25
NEGATIVE_POINTS = 10
# Use-backed strength halves for every 90 days the item goes unused.
USE_HALF_LIFE_DAYS = 90
ATTENTION_FACTOR = 0.5


def effective_confirmation_status(metadata: dict) -> str:
    status = metadata.get('confirmation_status', 'pending')
    basis = stored_confirmation_basis(metadata.get('confirmation_basis_json'))
    if basis is None:
        return 'pending'
    try:
        _validate_confirmation_state(status, basis)
    except ValueError:
        return 'pending'
    return status


def knowledge_weight(record, *, evidence_ids=(), now: datetime | None = None) -> dict:
    """The weight as a whole percent, and whether a person confirmed it.

    No stored confidence, caller-supplied weight or discovery score establishes
    human authority. The existing auditable confirmation policy alone does.
    Only real source IDs supplied by the authorized read query count as support.
    """
    status = effective_confirmation_status(record)
    if status == 'confirmed':
        basis = stored_confirmation_basis(record.get('confirmation_basis_json'))
        percent, confirmed_by_person = CONFIRMED_PERCENT, basis.confirmed_by.kind == 'user'
    else:
        lower, upper = AGENT_CONFIRMED_BAND if status == 'agent_confirmed' else PENDING_BAND
        percent = lower + (upper - lower) * _evidence_strength(record, evidence_ids, now) / 100
        confirmed_by_person = False
    if record.get('requires_attention') is True:
        percent *= ATTENTION_FACTOR
    return {'weight_percent': round(percent), 'confirmed_by_person': confirmed_by_person}


def ranking_weight(record, *, evidence_ids=()) -> float:
    """The shown percent as a 0-1 factor, so ranking uses exactly what people see."""
    return knowledge_weight(record, evidence_ids=evidence_ids)['weight_percent'] / 100


def _evidence_strength(record, evidence_ids, now) -> float:
    uses = max(0, int(record.get('qualified_use_count') or 0))
    tasks = max(0, int(record.get('distinct_task_count') or 0))
    negatives = max(0, int(record.get('negative_evidence_count') or 0))
    usage = (min(USE_CAP, uses * USE_POINTS) + min(TASK_CAP, tasks * TASK_POINTS)) * _recency(
        record.get('last_used_at'), now)
    support = min(SOURCE_CAP, len(set(evidence_ids)) * SOURCE_POINTS)
    return max(0.0, min(100.0, usage + support - negatives * NEGATIVE_POINTS))


def _recency(last_used_at, now) -> float:
    # Items used before last_used_at was stored carry no date; they do not fade.
    used_at = native_datetime(last_used_at)
    if not isinstance(used_at, datetime):
        return 1.0
    if used_at.tzinfo is None:
        used_at = used_at.replace(tzinfo=timezone.utc)
    days = max(0.0, ((now or datetime.now(timezone.utc)) - used_at).total_seconds() / 86400)
    return 0.5 ** (days / USE_HALF_LIFE_DAYS)
