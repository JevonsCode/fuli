"""Cypher SET item recording when a task participant entered running."""


def running_since_set(participant: str, status: str = '$status') -> str:
    """Stamp entry into running; place it before the participant's status write.

    Staying in running keeps the stamp, leaving running clears it. Rows
    written before the stamp existed keep null, which callers report as an
    unknown start rather than substituting an update time.
    """
    return (
        f"{participant}.running_since = CASE WHEN {status} <> 'running' THEN null "
        f"WHEN {participant}.status = 'running' THEN {participant}.running_since "
        'ELSE $updated_at END,'
    )
