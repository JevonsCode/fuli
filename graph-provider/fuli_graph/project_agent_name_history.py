"""The names an Agent was called before (改名历史), oldest first.

A rename only changes what people call an Agent: its identity, records and
signatures stay with its agent_id, and what was already said or signed under
the old name is never rewritten. The old name is kept here, with when it
ended and why: a person renamed it, or FULI gave it a new one because another
Agent of the space was called the same (graph/23). For FORMER_NAME_DAYS after
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


def former_name(history: list[ProjectAgentNameChange], now) -> str | None:
    """The name the Agent had until its latest rename, while that is recent."""
    if not history:
        return None
    latest = history[-1]
    return latest.name if native_datetime(now) - native_datetime(latest.until) <= timedelta(days=FORMER_NAME_DAYS) \
        else None
