"""The names an Agent was called before (改名历史), oldest first.

A rename only changes what people call an Agent: its identity, records and
signatures stay with its agent_id, and what was already said or signed under
the old name is never rewritten. The old name is kept here, with when it
ended and why: a person renamed it, or the person settled a name it shared with
another Agent of the space (store_project_agent_name_fixes.py). For FORMER_NAME_DAYS after
a rename the record also carries the old name as ``former_name``, so pages
and receipts can say 「原名 …」 while people still know it by that name.
"""
from datetime import timedelta
import json

from .project_agent_models import ProjectAgentNameChange
from .provider_values import native_datetime

FORMER_NAME_DAYS = 30


def with_former_name(history_json: str | None, change: ProjectAgentNameChange) -> str:
    """The stored history with one more former name."""
    history = json.loads(history_json or '[]')
    return json.dumps([*history, change.model_dump(mode='json', exclude_none=True)], ensure_ascii=False)


def name_history(history_json: str | None) -> list[ProjectAgentNameChange]:
    return [ProjectAgentNameChange.model_validate(item) for item in json.loads(history_json or '[]')]


def recent_change(history: list[ProjectAgentNameChange], now) -> ProjectAgentNameChange | None:
    """The Agent's latest rename while its old name is still its 原名: people
    still call it by that name, so no other Agent may take it until then."""
    if not history:
        return None
    latest = history[-1]
    return latest if native_datetime(now) - native_datetime(latest.until) <= timedelta(days=FORMER_NAME_DAYS) \
        else None


def former_name(history: list[ProjectAgentNameChange], now) -> str | None:
    """The name the Agent had until its latest rename, while that is recent."""
    change = recent_change(history, now)
    return change.name if change else None


def free_from(change: ProjectAgentNameChange):
    """When a 原名 stops being one, and another Agent may take it."""
    return native_datetime(change.until) + timedelta(days=FORMER_NAME_DAYS)
