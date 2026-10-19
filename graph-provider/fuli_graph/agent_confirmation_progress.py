from . import knowledge_audit
from .graph_models import AgentConfirmationProgress
from .negative_feedback_block import agent_authority_suspension


def agent_confirmation_progress(
    record,
    *,
    knowledge_conflicts,
    preference_conflicts,
) -> AgentConfirmationProgress:
    """Read-only view of the usage promotion rule in knowledge_audit.

    Thresholds are read from the write-side constants at call time. The open
    conflict test mirrors the write-side has_open_conflict check: a pending
    knowledge conflict or an ai_pending preference conflict on this item.
    Negative feedback blocks it through the same rule the writer applies.
    Raw counts stay None when the item never stored them, so callers can show
    unknown instead of zero.
    """
    stored_status = record.get('confirmation_status') or 'pending'
    uses = _raw_count(record.get('raw_qualified_use_count'))
    tasks = _raw_count(record.get('raw_distinct_task_count'))
    required_uses = knowledge_audit.AGENT_CONFIRMATION_MIN_USES
    required_tasks = knowledge_audit.AGENT_CONFIRMATION_MIN_TASKS
    has_open_conflict = (
        any(_field(conflict, 'status') == 'pending'
            for conflict in knowledge_conflicts)
        or bool(preference_conflicts)
    )
    reasons = []
    if stored_status != 'pending':
        reasons.append('not_pending')
    if has_open_conflict:
        reasons.append('open_conflict')
    if suspension := agent_authority_suspension(record):
        reasons.append(suspension)
    if uses is None or tasks is None:
        reasons.append('usage_unknown')
    else:
        if uses < required_uses:
            reasons.append('qualified_uses_below_threshold')
        if tasks < required_tasks:
            reasons.append('distinct_tasks_below_threshold')
    return AgentConfirmationProgress(
        required_qualified_uses=required_uses,
        required_distinct_tasks=required_tasks,
        qualified_use_count=uses,
        distinct_task_count=tasks,
        has_open_conflict=has_open_conflict,
        blocking_reasons=reasons,
    )


def _raw_count(value):
    return None if value is None else int(value)


def _field(value, name):
    if isinstance(value, dict):
        return value.get(name)
    return getattr(value, name, None)
