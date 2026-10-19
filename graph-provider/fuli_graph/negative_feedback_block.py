"""How negative feedback suspends usage-derived (agent_confirmed) authority.

Repeated Agent use can confirm knowledge only while nothing argues against it.
Unresolved negative evidence from any reporter suspends that authority: the item
is neither promoted by usage nor delivered as an effective preference. Feedback
from the user or an authoritative source also stores a durable block that names
its audit record, reporter, time and usage generation. The block survives later
use, content revisions and generation changes; only an explicit human
confirmation lifts it, and that revision keeps the block in its history.
Human-confirmed knowledge keeps its authority and is only flagged for attention.

Items stored before the block existed carry no block field. They behave as
before unless they hold negative evidence, which suspends them the same way.
"""

import json
from datetime import datetime

TRUSTED_FEEDBACK_REPORTERS = frozenset({'user', 'authoritative_source'})


def negative_feedback_block_json(
    *,
    audit_id: str,
    feedback_kind: str,
    reported_by_kind: str,
    blocked_at: datetime,
    usage_generation: int,
) -> str:
    return json.dumps({
        'audit_id': audit_id,
        'feedback_kind': feedback_kind,
        'reported_by_kind': reported_by_kind,
        'blocked_at': blocked_at.isoformat(),
        'usage_generation': usage_generation,
    }, ensure_ascii=False, sort_keys=True)


def agent_authority_suspension(record) -> str | None:
    """Why usage cannot confirm, or keep confirmed, this item; None when it can.

    The record carries `confirmation_status`, the stored block JSON as
    `negative_feedback_block_json` and `negative_evidence_count`. Promotion,
    effective-preference delivery, the graph view and usage ranking all read
    this one answer; human-confirmed knowledge is never suspended.
    """
    if record.get('confirmation_status') == 'confirmed':
        return None
    if record.get('negative_feedback_block_json'):
        return 'negative_feedback_block'
    if int(record.get('negative_evidence_count') or 0) > 0:
        return 'negative_evidence'
    return None
