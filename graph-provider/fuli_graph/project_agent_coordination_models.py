from datetime import datetime

from pydantic import Field

from .models import StrictModel


class ProjectAgentCoordinationPolicyRecord(StrictModel):
    """Project-local authorization for Agent continuity and recruitment."""

    personal_space_id: str
    personal_project_id: str
    ask_before_recruitment: bool = True
    auto_reuse_previous_agent: bool = True
    updated_at: datetime | None = None


class ProjectAgentCoordinationPolicyUpdate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    ask_before_recruitment: bool = True
    auto_reuse_previous_agent: bool = True
