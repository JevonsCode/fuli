"""Read-only task-entry selection; never submits a task or spawns a worker."""

from typing import Literal

from pydantic import Field

from .models import SourceApplication, StrictModel
from .project_agent_memory_models import MemoryNote
from .project_agent_models import ProjectAgentRecord


class ProjectAgentContextRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    agent_id: str | None = Field(default=None, min_length=1, max_length=128)
    session_id: str | None = Field(default=None, min_length=1, max_length=256)
    turn_id: str | None = Field(default=None, min_length=1, max_length=256)
    work_kind: str = Field(default='project_context', min_length=1, max_length=128)
    required_capabilities: list[MemoryNote] = Field(default_factory=list, max_length=16)
    source_application: SourceApplication = 'other'


class ProjectAgentContextResolution(StrictModel):
    status: Literal['ready', 'manual_selection', 'unassigned', 'agent_unavailable']
    reason: str
    match_basis: list[str] = Field(default_factory=list)
    candidate_count: int = 0
    agent: ProjectAgentRecord | None = None
    worker_started: Literal[False] = False
