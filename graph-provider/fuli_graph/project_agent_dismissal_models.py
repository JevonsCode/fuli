"""Contracts for dismissing an Agent with a reason, its lessons and its handoff.

The reason comes from the person who asked for the dismissal. Lessons are the
few reusable sentences later Agents of the same occupation or project may look
up on demand; they are never pushed into another Agent's task context.
"""

import unicodedata
from datetime import datetime
from typing import Annotated, Literal

from pydantic import Field, StringConstraints, model_validator

from .model_validation import reject_credentials, unique_text_list
from .models import SourceApplication, StrictModel

DISMISSAL_TEXT_LIMIT = 1000
MAX_DISMISSAL_LESSONS = 3
MAX_HANDOFF_BYTES = 512 * 1024
DEFAULT_LESSON_LIMIT = 5
MAX_LESSON_LIMIT = 10

# Stand-ins people or Agents type instead of a reason, compared without case,
# spaces or punctuation. A real reason says what went wrong. The Node host
# refuses the same list before it renders a handoff; test/agent-dismissal.test.js
# keeps them equal.
PLACEHOLDER_REASONS = frozenset({
    'archivedbyuser', 'archived', 'archive', 'dismiss', 'dismissed', 'fired', 'noreason', 'none',
    'unknown', 'test', 'todo', 'tbd', '无', '没有', '没有理由', '无理由', '不知道', '开除', '归档', '离职',
})


def bare_reason(value: str) -> str:
    """The reason lowercased without whitespace, punctuation or symbols."""
    return ''.join(character for character in value.lower() if not character.isspace()
                   and unicodedata.category(character)[0] not in {'P', 'S'})


DismissalText = Annotated[str, StringConstraints(
    strip_whitespace=True, min_length=4, max_length=DISMISSAL_TEXT_LIMIT)]


class ProjectAgentHandoff(StrictModel):
    filename: str = Field(min_length=1, max_length=160)
    # The generated document is stored exactly as rendered.
    markdown: Annotated[str, StringConstraints(strip_whitespace=False, min_length=1)]

    @model_validator(mode='after')
    def bounded(self):
        if len(self.markdown.encode()) > MAX_HANDOFF_BYTES:
            raise ValueError('the handoff document must fit within 512 KiB')
        return self


class ProjectAgentDismissal(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    reason: DismissalText
    # Omitted lessons keep the reason itself as the one lesson.
    lessons: list[DismissalText] = Field(default_factory=list, max_length=MAX_DISMISSAL_LESSONS)
    handoff: ProjectAgentHandoff
    source_application: SourceApplication | None = None
    source_session_id: str | None = Field(default=None, min_length=1, max_length=256)

    @model_validator(mode='after')
    def normalize(self):
        if bare_reason(self.reason) in PLACEHOLDER_REASONS:
            raise ValueError('the dismissal reason is a placeholder; '
                             'ask the user why this Agent is being dismissed')
        self.lessons = unique_text_list(self.lessons, 'dismissal lessons',
                                        maximum=DISMISSAL_TEXT_LIMIT) or [self.reason]
        reject_credentials(self, 'Agent dismissal')
        return self


class ProjectAgentDismissalReceipt(StrictModel):
    """What a dismissal returns: identifiers and counts, never the handoff text."""

    dismissal_id: str
    agent_id: str
    agent_name: str
    employee_number: str | None = None
    occupation_role: str | None = None
    project_ids: list[str] = Field(default_factory=list)
    lesson_count: int = Field(ge=1)
    handoff_filename: str
    handoff_characters: int = Field(ge=1)
    dismissed_at: datetime
    replayed: bool = False


class ProjectAgentDismissalLesson(StrictModel):
    dismissal_id: str
    agent_id: str
    agent_name: str
    employee_number: str | None = None
    occupation_role: str | None = None
    project_ids: list[str] = Field(default_factory=list)
    reason: str
    lessons: list[str]
    dismissed_at: datetime
    matched_by: list[Literal['occupation', 'project']]


class ProjectAgentDismissalLessons(StrictModel):
    total: int = Field(ge=0)
    items: list[ProjectAgentDismissalLesson] = Field(default_factory=list)


class ProjectAgentDismissalRecord(StrictModel):
    dismissal_id: str
    agent_id: str
    agent_name: str
    employee_number: str | None = None
    occupation_role: str | None = None
    occupation_tags: list[str] = Field(default_factory=list)
    project_ids: list[str] = Field(default_factory=list)
    reason: str
    lessons: list[str]
    handoff: ProjectAgentHandoff
    source_application: SourceApplication | None = None
    source_session_id: str | None = None
    dismissed_at: datetime
