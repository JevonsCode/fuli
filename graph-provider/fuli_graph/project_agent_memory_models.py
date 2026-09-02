"""Provider-neutral contracts for private Agent working context.

Working notes are not confirmed project knowledge or user preferences. Their
scope and revision travel with every response, regardless of the calling host.
"""

from datetime import datetime
import json
from typing import Annotated, Literal

from pydantic import Field, StringConstraints, model_validator

from .model_validation import reject_credentials
from .models import SourceApplication, StrictModel


MemoryNote = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1024)
]


class ProjectAgentWorkingMemory(StrictModel):
    summary: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)
    ]
    decisions: list[MemoryNote] = Field(default_factory=list, max_length=12)
    open_threads: list[MemoryNote] = Field(default_factory=list, max_length=12)
    next_actions: list[MemoryNote] = Field(default_factory=list, max_length=12)

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        reject_credentials(self, 'Agent working memory')
        if len(json.dumps(self.model_dump(), ensure_ascii=False).encode()) > 32 * 1024:
            raise ValueError('Agent working memory must fit within 32 KiB; distill the notes')
        return self


class ProjectAgentMemoryWrite(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    agent_id: str = Field(min_length=1, max_length=128)
    expected_revision: int = Field(ge=0)
    idempotency_key: str = Field(min_length=8, max_length=256)
    memory: ProjectAgentWorkingMemory
    source_application: SourceApplication
    source_session_id: str | None = Field(default=None, min_length=1, max_length=256)
    task_id: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        reject_credentials(self, 'Agent memory checkpoint')
        return self


class ProjectAgentMemoryRecord(StrictModel):
    checkpoint_id: str
    personal_space_id: str
    personal_project_id: str
    agent_id: str
    revision: int = Field(ge=1)
    memory: ProjectAgentWorkingMemory
    source_application: SourceApplication
    source_session_id: str | None = None
    task_id: str | None = None
    created_at: datetime


class ProjectAgentMemoryView(StrictModel):
    personal_space_id: str
    personal_project_id: str
    agent_id: str
    scope: Literal['private_agent_project'] = 'private_agent_project'
    storage: Literal['neo4j'] = 'neo4j'
    authority: Literal['working_context_not_confirmed_knowledge'] = (
        'working_context_not_confirmed_knowledge'
    )
    revision: int = Field(default=0, ge=0)
    current: ProjectAgentMemoryRecord | None = None
    history: list[ProjectAgentMemoryRecord] = Field(default_factory=list)
