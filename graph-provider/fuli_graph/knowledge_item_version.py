"""Optimistic concurrency for one knowledge item (rec#20 quick edit).

Every writer of an item bumps fuli_ai_review_lock_version, so it is the
version an editor read. An edit that names an older version is refused with
the current one, instead of overwriting newer content from a stale page or link.
"""
from fastapi import HTTPException


def item_version(record: dict) -> int:
    return int(record.get('ai_review_lock_version') or 0)


def require_item_version(record: dict, expected: int | None) -> None:
    if expected is None:
        return
    current = item_version(record)
    if expected != current:
        raise HTTPException(status_code=409, detail={
            'code': 'stale_version', 'current_version': current,
            'message': 'knowledge changed since it was read; read it again before editing',
        })
