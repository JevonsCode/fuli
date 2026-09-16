from datetime import datetime

from pydantic import Field, field_validator, model_validator

from .models import StrictModel


class ProjectAgentCoordinationPolicyRecord(StrictModel):
    """Project-local authorization for Agent continuity and recruitment."""

    personal_space_id: str
    personal_project_id: str
    ask_before_recruitment: bool = True
    auto_reuse_previous_agent: bool = True
    auto_grow_team: bool = True
    team_lead_agent_id: str | None = None
    team_member_agent_ids: list[str] = Field(default_factory=list)
    updated_at: datetime | None = None


class ProjectAgentCoordinationPolicyUpdate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    ask_before_recruitment: bool = True
    auto_reuse_previous_agent: bool = True
    auto_grow_team: bool | None = None
    team_lead_agent_id: str | None = Field(default=None, min_length=1, max_length=128)
    team_member_agent_ids: list[str] = Field(default_factory=list, max_length=32)
    expected_updated_at: datetime | None = None

    @field_validator('team_member_agent_ids')
    @classmethod
    def validate_members(cls, value):
        if any(not item.strip() or len(item) > 128 for item in value):
            raise ValueError('team member IDs must contain 1 to 128 characters')
        if len(set(value)) != len(value):
            raise ValueError('team member IDs must be unique')
        return value

    @model_validator(mode='after')
    def validate_team(self):
        if self.team_lead_agent_id in self.team_member_agent_ids:
            raise ValueError('the team lead cannot also be a team member')
        return self
