"""Long-term occupation of a project Agent, kept apart from its current task."""

from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator

from .models import StrictModel

ProjectAgentOccupationKey = Literal[
    'product',
    'engineering',
    'design',
    'operations',
    'testing',
    'research',
    'data',
    'writing',
    'management',
]


class ProjectAgentOccupation(StrictModel):
    """A person-set primary role plus a few extra ability tags.

    It only describes what the Agent is for; it never grants permissions or
    proves a skill. ``updated_at`` is the last explicit human edit.
    """

    role: ProjectAgentOccupationKey | None = None
    tags: list[ProjectAgentOccupationKey] = Field(default_factory=list, max_length=5)
    updated_at: datetime

    @field_validator('tags')
    @classmethod
    def unique_tags(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError('occupation tags must be unique')
        return value


class ProjectAgentOccupationUpdate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    role: ProjectAgentOccupationKey | None = None
    tags: list[ProjectAgentOccupationKey] = Field(default_factory=list, max_length=5)

    @field_validator('tags')
    @classmethod
    def unique_tags(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError('occupation tags must be unique')
        return value
