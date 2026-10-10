"""Version-bound AI review evidence helpers.

An AI decision is useful only for the exact item snapshot that was supplied to
the model.  Keep the digest deliberately independent from timestamps: edits can
be visible in the graph before a separate revision or audit timestamp moves.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime
from typing import Any


_DIRECT_FIELDS = (
    'item_kind',
    'item_id',
    'title',
    'content',
    'valid_at',
    'invalid_at',
    'confirmation_status',
    'confirmation_basis_json',
    'profile_aspect',
    'preference_scope',
    'preference_project_id',
    'preference_agent_id',
    'inheritance_mode',
    'current_quadrant',
    'utility_score',
    'confidence_score',
    'qualified_use_count',
    'distinct_task_count',
    'negative_evidence_count',
    'requires_attention',
    'human_change_version',
    'attributes_json',
    'attributes',
)


def _json_safe(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    to_native = getattr(value, 'to_native', None)
    if callable(to_native):
        return _json_safe(to_native())
    if hasattr(value, 'model_dump'):
        return _json_safe(value.model_dump(mode='json'))
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, set):
        return sorted((_json_safe(item) for item in value), key=repr)
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


def _canonical_value(item: dict[str, Any], key: str) -> Any:
    value = item.get(key)
    if key == 'attributes' and value is None:
        value = item.get('attributes_json')
    if key == 'attributes_json' and value is None:
        value = item.get('attributes')
    if key in {'attributes', 'attributes_json'}:
        if value in (None, '', '{}'):
            return {}
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except (TypeError, ValueError):
                pass
    return _json_safe(value)


def ai_review_evidence_payload(
    item: dict[str, Any],
    *,
    scope: str,
    personal_project_id: str | None,
    has_conflict: bool,
) -> dict[str, Any]:
    """Build the complete evidence identity used by candidate and CAS paths."""

    payload = {
        'direct': {
            key: _canonical_value(item, key)
            for key in _DIRECT_FIELDS
        },
        'scope': scope,
        'personal_project_id': personal_project_id,
        'project_ids': sorted({
            str(project_id)
            for project_id in (item.get('project_ids') or [])
            if project_id
        }),
        'has_conflict': bool(has_conflict),
    }
    return _json_safe(payload)


def ai_review_evidence_token(
    item: dict[str, Any],
    *,
    scope: str,
    personal_project_id: str | None,
    has_conflict: bool,
) -> str:
    """Return a deterministic SHA-256 token for the reviewable item snapshot."""

    encoded = json.dumps(
        ai_review_evidence_payload(
            item,
            scope=scope,
            personal_project_id=personal_project_id,
            has_conflict=has_conflict,
        ),
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
    ).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def effective_ai_review(
    item: dict[str, Any],
    *,
    stored_token: str | None,
    stored_assessment: dict[str, Any] | str | None,
    scope: str,
    personal_project_id: str | None,
    has_conflict: bool,
) -> dict[str, Any] | None:
    """Expose an assessment only while its exact current evidence still holds."""

    if not stored_token or item.get('requires_attention') is True or has_conflict:
        return None
    current_token = ai_review_evidence_token(
        item,
        scope=scope,
        personal_project_id=personal_project_id,
        has_conflict=has_conflict,
    )
    if current_token != stored_token:
        return None
    if isinstance(stored_assessment, str):
        try:
            stored_assessment = json.loads(stored_assessment)
        except (TypeError, ValueError):
            return None
    if not isinstance(stored_assessment, dict):
        return None
    return stored_assessment
