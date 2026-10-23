"""How one preference meets a task: applies, scope_unknown or excluded.

The Provider's copy of src/graphiti/preference-task-scope.js, applied before
same-key overrides and conflicts. Every dimension an item states must hold;
a list within one dimension is any of its values. A definite mismatch
excludes; otherwise a stated dimension the task does not supply fails closed
as scope_unknown (not applied, listed by key only). An item with no scene key
follows the general rule in task_scene.py.
"""

import re

from .provider_values import json_object
from .task_scene import EVERY_SCENE, general_item_excluded, taste_domain_scenes

APPLIES = 'applies'
SCOPE_UNKNOWN = 'scope_unknown'
EXCLUDED = 'excluded'

_SESSION_KEYS = ('sessionId', 'session_id', 'sessionIds', 'session_ids')
_WORK_KIND_KEYS = ('workKind', 'work_kind', 'workKinds', 'work_kinds')
_WORKFLOW_KEYS = ('workflow', 'workflows')


def item_qualifiers(item) -> dict:
    return {**item.attributes, **json_object(item.attributes.get('preference_qualifiers')),
            **item.preference_qualifiers}


def preference_task_applicability(qualifiers: dict, instruction, session_id, work_kind,
                                  workflow) -> str:
    session = _first(qualifiers, _SESSION_KEYS)
    if session is None and not any(key in qualifiers for key in _SESSION_KEYS):
        session = _legacy_session(instruction)
    domain = taste_domain_scenes(qualifiers)
    stated = [
        condition for condition in (
            (_condition_values(session), session_id, False),
            (_condition_values(_first(qualifiers, _WORK_KIND_KEYS)), work_kind, True),
            (_condition_values(_first(qualifiers, _WORKFLOW_KEYS)), workflow, False),
            (domain, work_kind, True),
        ) if condition[0] is not None
    ]
    conditions = [condition for condition in stated if condition[0] != EVERY_SCENE]
    if any(not values or (actual and actual not in values) for values, actual, _ in conditions):
        return EXCLUDED
    if not any(scene for _, _, scene in stated) and general_item_excluded(qualifiers, work_kind):
        return EXCLUDED
    return SCOPE_UNKNOWN if any(not actual for _, actual, _ in conditions) else APPLIES


def _legacy_session(instruction):
    # Read compatibility only; provenance/ambiguous business prose never scopes.
    match = re.match(r'^仅(?:在|适用于)\s*(?:Codex|Claude Code|Cursor)\s*会话\s+'
                     r'([a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})'
                     r'\s*(?:中|的|后续|[，,：:])', instruction or '')
    return match[1] if match else None


def _first(qualifiers, keys):
    # Like JavaScript `a ?? b`: the first key whose value is not null.
    return next((qualifiers[key] for key in keys if qualifiers.get(key) is not None), None)


def _condition_values(condition):
    if isinstance(condition, str) and condition.strip():
        return [condition]
    if isinstance(condition, list) and condition and all(
            isinstance(value, str) and value.strip() for value in condition):
        return condition
    return None
