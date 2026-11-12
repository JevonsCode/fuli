"""What a blocked task is waiting for, read from its recorded history.

The current block is the run of trailing events that set the task to blocked:
its first event is when the block began, its latest names the reason and the
session that reported it. Nothing is inferred from configuration.
"""

from .project_agent_task_models import (
    ProjectAgentTaskBlocker,
    ProjectAgentTaskBlockerHint,
    ProjectAgentTaskEventRecord,
)
from .provider_values import native_datetime

# The person's 「标记为已解除」 keeps their note as the event's summary, or
# this sentence when they wrote none.
PERSON_CLEAR_SUMMARY = 'Marked as unblocked by the person in FULI.'
# The person confirmed a block FULI saw as probably resolved, without a note.
PERSON_CONFIRM_SUMMARY = 'Confirmed as unblocked by the person after the Agent went on in another session.'
# Why another session's status report cannot move a blocked task on, and what
# does (rec#123). The Agent-facing message is cut at 240 characters and the
# Node client turns ':' into ' —', so it names the route without its path.
BLOCKED_MOVE_GUIDANCE = (
    'needs the session that reported the block or its lead Agent. Fixed the block? Clear it via '
    'run_delegated_action, task blocker/clear route (params.taskId, reason = what you fixed), '
    'then report the status'
)


def current_blocker(
    status: str,
    events: list[ProjectAgentTaskEventRecord],
    stored_summary: str | None,
    hint: dict | None = None,
) -> ProjectAgentTaskBlocker | None:
    """The block of a blocked task; None for any other status. events are oldest first.

    hint is the task's stored blocker_hint_* properties; it says probably
    resolved only when it is newer than the block's latest report, so a block
    reported again after it takes the hint back.
    """
    if status != 'blocked':
        return None
    streak = []
    for event in reversed(events):
        if event.status != 'blocked':
            break
        streak.append(event)
    if not streak:
        return ProjectAgentTaskBlocker(reason=stored_summary, probably_resolved=_hint(hint, None, None))
    latest = streak[0]
    return ProjectAgentTaskBlocker(
        reason=latest.summary,
        since=streak[-1].created_at,
        agent_id=latest.agent_id,
        source_application=latest.source_application,
        source_session_id=latest.source_session_id,
        source_session_url=latest.source_session_url,
        probably_resolved=_hint(hint, latest.created_at, (latest.source_application, latest.source_session_id)),
    )


def _hint(hint, reported_at, session) -> ProjectAgentTaskBlockerHint | None:
    if not hint or not hint.get('blocker_hint_agent_id') or not hint.get('blocker_hint_at'):
        return None
    evidence = ProjectAgentTaskBlockerHint(
        agent_id=hint['blocker_hint_agent_id'],
        source_application=hint.get('blocker_hint_source_application'),
        source_session_id=hint.get('blocker_hint_source_session_id'),
        at=native_datetime(hint['blocker_hint_at']),
    )
    if reported_at and evidence.at <= reported_at:
        return None
    if session and session[1] and (evidence.source_application, evidence.source_session_id) == session:
        return None
    return evidence


def blocked_in_session(
    blocker: ProjectAgentTaskBlocker | None,
    source_application: str | None,
    source_session_id: str | None,
) -> bool:
    """True when this client session is the one that reported the block."""
    return bool(
        blocker
        and source_session_id
        and blocker.source_session_id == source_session_id
        and blocker.source_application == source_application
    )


def blocker_clear_note(cause: str | None, summary: str | None) -> str | None:
    """What the clearer wrote: the person's note, or the reason an Agent gave."""
    if cause not in ('person', 'person_confirmed', 'agent') or not summary:
        return None
    if summary in (PERSON_CLEAR_SUMMARY, PERSON_CONFIRM_SUMMARY):
        return None
    return summary
