"""Durable lifecycle metadata, never prompts, local paths or transcripts."""

from typing import Literal

from pydantic import Field, model_validator

from .models import SourceApplication, StrictModel
from .model_validation import reject_credentials
from .project_agent_memory_models import ProjectAgentWorkingMemory


class TaskContextBegin(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    project_agent_id: str | None = Field(default=None, min_length=1, max_length=128)
    session_id: str = Field(min_length=1, max_length=256)
    source_application: SourceApplication
    source_session_id: str | None = Field(default=None, min_length=1, max_length=256)
    token: str = Field(pattern=r'^fuli-task-[a-zA-Z0-9-]{8,128}$')
    turn_id: str | None = Field(default=None, min_length=1, max_length=256)
    memory_revision: int | None = Field(default=None, ge=0)

    @model_validator(mode='after')
    def require_project_for_agent(self):
        if self.project_agent_id and not self.personal_project_id:
            raise ValueError('Agent lifecycle requires an exact project')
        return self


class TaskContextAgentMemory(StrictModel):
    expected_revision: int = Field(ge=0)
    memory: ProjectAgentWorkingMemory


class TaskContextCheckpoint(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    source_application: SourceApplication
    phase: Literal['prepare', 'complete'] = 'complete'
    disposition: Literal['capture_candidates', 'retain_nothing']
    reason: str = Field(min_length=1, max_length=2000)
    fingerprint: str = Field(pattern=r'^[a-f0-9]{64}$')
    capture_status: str | None = Field(default=None, max_length=128)
    agent_memory: TaskContextAgentMemory | None = None

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        if self.agent_memory is not None and self.phase != 'prepare':
            raise ValueError('Agent memory belongs to atomic checkpoint preparation')
        reject_credentials(self, 'task checkpoint')
        return self
