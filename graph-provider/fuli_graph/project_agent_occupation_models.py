"""Long-term occupation of a project Agent, kept apart from its current task."""

from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator

from .models import StrictModel

ProjectAgentOccupationKey = Literal[
    'lead',
    'assistant',
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


class ProjectAgentOccupationInput(StrictModel):
    """An explicit primary role plus a few extra ability tags.

    It only describes what the Agent is for; it never grants permissions or
    proves a skill. Bole records its recruitment decision separately.
    """

    role: ProjectAgentOccupationKey
    tags: list[ProjectAgentOccupationKey] = Field(default_factory=list, max_length=5)

    @field_validator('tags')
    @classmethod
    def unique_tags(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError('occupation tags must be unique')
        return value


class ProjectAgentOccupation(ProjectAgentOccupationInput):
    updated_at: datetime


class ProjectAgentOccupationUpdate(ProjectAgentOccupationInput):
    personal_space_id: str = Field(min_length=1, max_length=128)
