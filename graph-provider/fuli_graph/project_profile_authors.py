"""Who wrote each project profile field. The transition rules live in Node
(src/graphiti/project-profile-authors.js); the Provider stores the records and
gives profiles saved before them a default."""
from datetime import datetime
from typing import Literal

from pydantic import Field

from .model_base import StrictModel

AUTHORED_FIELDS = ('purpose', 'scope', 'technical_summary', 'boundaries')
AuthoredField = Literal['purpose', 'scope', 'technical_summary', 'boundaries']


class ProjectFieldAuthor(StrictModel):
    kind: Literal['person', 'agent', 'both']
    agent_id: str | None = Field(default=None, min_length=1, max_length=256)
    agent_name: str | None = Field(default=None, min_length=1, max_length=160)
    # None only for a record defaulted from a profile saved before authors existed.
    updated_at: datetime | None = None


def _has_text(value) -> bool:
    if isinstance(value, list):
        return any(item and item.strip() for item in value)
    return bool(value and value.strip())


def default_field_authors(profile) -> dict:
    """Records for non-empty fields that have none; empty fields keep none.

    The store cannot tell who typed a field saved before authors existed. Such
    text came from the console, so it defaults to 'person', except a purpose
    still marked as an AI draft (brief_draft), which is 'agent'.
    """
    authors = {name: record for name, record in (profile.authors or {}).items()
               if _has_text(getattr(profile, name))}
    for name in AUTHORED_FIELDS:
        if name not in authors and _has_text(getattr(profile, name)):
            draft = name == 'purpose' and profile.brief_draft is not None
            authors[name] = ProjectFieldAuthor(kind='agent' if draft else 'person')
    return authors
