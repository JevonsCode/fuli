from datetime import datetime

from pydantic import Field, field_validator, model_validator

from .models import StrictModel


def member_ids(value):
    if any(not item.strip() or len(item) > 128 for item in value) or len(set(value)) != len(value):
        raise ValueError('member IDs must be unique and contain 1 to 128 characters')
    return value


class ProjectAgentSubTeam(StrictModel):
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=120)
    lead_agent_id: str = Field(min_length=1, max_length=128)
    member_agent_ids: list[str] = Field(default_factory=list, max_length=32)

    @field_validator('id', 'name', 'lead_agent_id')
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError('sub-team values cannot be blank')
        return value

    @field_validator('member_agent_ids')
    @classmethod
    def members(cls, value):
        return member_ids(value)


def validate_sub_team_layout(groups):
    ids, people = set(), set()
    for group in groups:
        roles = [group.lead_agent_id, *group.member_agent_ids]
        if group.id in ids or len(set(roles)) != len(roles) or people.intersection(roles):
            raise ValueError('sub-teams require unique IDs and disjoint leads/members')
        ids.add(group.id)
        people.update(roles)
    return groups


def validate_sub_team_membership(lead, members, groups):
    validate_sub_team_layout(groups)
    assigned = set(members)
    for group in groups:
        if not lead or any(person == lead or person not in assigned
                           for person in [group.lead_agent_id, *group.member_agent_ids]):
            raise ValueError('sub-team roles must belong to the explicit project members')


class ProjectAgentCoordinationPolicyRecord(StrictModel):
    """Project-local authorization for Agent continuity and recruitment."""

    personal_space_id: str
    personal_project_id: str
    ask_before_recruitment: bool = True
    auto_reuse_previous_agent: bool = True
    auto_grow_team: bool = True
    team_lead_agent_id: str | None = None
    team_member_agent_ids: list[str] = Field(default_factory=list)
    sub_teams: list[ProjectAgentSubTeam] = Field(default_factory=list)
    sub_team_suggestion_threshold: int = 6
    updated_at: datetime | None = None


class ProjectAgentCoordinationPolicyUpdate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    ask_before_recruitment: bool = True
    auto_reuse_previous_agent: bool = True
    auto_grow_team: bool | None = None
    team_lead_agent_id: str | None = Field(default=None, min_length=1, max_length=128)
    team_member_agent_ids: list[str] = Field(default_factory=list, max_length=32)
    sub_teams: list[ProjectAgentSubTeam] = Field(default_factory=list, max_length=32)
    sub_team_suggestion_threshold: int = Field(default=6, ge=1, le=32)
    expected_updated_at: datetime | None = None

    @field_validator('team_member_agent_ids')
    @classmethod
    def validate_members(cls, value):
        return member_ids(value)

    @field_validator('sub_teams')
    @classmethod
    def validate_groups(cls, value):
        return validate_sub_team_layout(value)

    @model_validator(mode='after')
    def validate_team(self):
        if self.team_lead_agent_id in self.team_member_agent_ids:
            raise ValueError('the team lead cannot also be a team member')
        if {'team_lead_agent_id', 'team_member_agent_ids'}.issubset(self.model_fields_set):
            validate_sub_team_membership(self.team_lead_agent_id, self.team_member_agent_ids, self.sub_teams)
        return self
