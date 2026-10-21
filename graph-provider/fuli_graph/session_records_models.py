"""What one host session recorded (rec#5 C6), read back from storage.

The same source references a knowledge item's view uses (G1-4) read the other
way: from a session to the transcript turns it saved, the knowledge its
episodes created or updated, and the words that became preference evidence.
Nothing here is a model's claim, and nothing here grants access.
"""
from datetime import datetime
from typing import Literal

from pydantic import Field

from .knowledge_item_view_models import KnowledgeItemSummary, KnowledgeScopeProject
from .model_base import StrictModel
from .models import SourceApplication

# 'evidence': the episode only cited an existing preference again, so its words
# became evidence for it without changing it.
SessionRecordChange = Literal['created', 'updated', 'evidence']


class SessionRecordsRead(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    source_application: SourceApplication
    session_id: str = Field(min_length=1, max_length=256)


class SessionTurnMessage(StrictModel):
    role: Literal['user', 'assistant']
    text: str
    created_at: datetime | None = None


class SessionNotRecorded(StrictModel):
    """A content-free journal marker: native bytes FULI skipped. after: when
    the journal last saved something before it, so the stretch has a start."""
    content: str
    created_at: datetime | None = None
    after: datetime | None = None


class SessionCaptureOff(StrictModel):
    """Why a turn recorded nothing, from the note FULI stored in place of its
    summary: the decision's layer and reason only, never the turn's content.
    layer is None when the checkpoint says capture was off but not why."""
    layer: str | None = Field(default=None, max_length=32)
    reason: str = Field(max_length=64)


class SessionTurn(StrictModel):
    """One FULI task of the session, which is one user→AI turn."""
    task_id: str
    turn_id: str | None = None
    created_at: datetime | None = None
    personal_project_id: str | None = None
    conversation_id: str | None = None
    # Set when capture was off for this turn's checkpoint.
    capture_off: SessionCaptureOff | None = None
    messages: list[SessionTurnMessage] = Field(default_factory=list)
    not_recorded: list[SessionNotRecorded] = Field(default_factory=list)


class SessionRecordItem(KnowledgeItemSummary):
    change: SessionRecordChange
    episode_id: str
    task_id: str | None = None
    recorded_at: datetime | None = None
    # The project of the turn that wrote it (its task's, else its episode's):
    # whose context it came from, which may differ from where it applies.
    origin_project_id: str | None = None
    conversation_id: str | None = None
    excerpt: str | None = None


class SessionRecords(StrictModel):
    session_id: str
    source_application: str
    turns: list[SessionTurn] = Field(default_factory=list)
    items: list[SessionRecordItem] = Field(default_factory=list)
    projects: list[KnowledgeScopeProject] = Field(default_factory=list)
    # True when the session holds more than one read returns; the newest are kept.
    truncated: bool = False
