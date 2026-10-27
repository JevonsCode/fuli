"""What a blocked task is waiting for, read from its recorded history.

The current block is the run of trailing events that set the task to blocked:
its first event is when the block began, its latest names the reason and the
session that reported it. Nothing is inferred from configuration.
"""

from .project_agent_task_models import ProjectAgentTaskBlocker, ProjectAgentTaskEventRecord


def current_blocker(
    status: str,
    events: list[ProjectAgentTaskEventRecord],
    stored_summary: str | None,
) -> ProjectAgentTaskBlocker | None:
    """The block of a blocked task; None for any other status. events are oldest first."""
    if status != 'blocked':
        return None
    streak = []
    for event in reversed(events):
        if event.status != 'blocked':
            break
        streak.append(event)
    if not streak:
        return ProjectAgentTaskBlocker(reason=stored_summary)
    latest = streak[0]
    return ProjectAgentTaskBlocker(
        reason=latest.summary,
        since=streak[-1].created_at,
        agent_id=latest.agent_id,
        source_application=latest.source_application,
        source_session_id=latest.source_session_id,
        source_session_url=latest.source_session_url,
    )


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
