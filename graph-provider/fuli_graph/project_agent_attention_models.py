from datetime import datetime
from typing import Literal

from pydantic import Field, model_validator

from .model_base import StrictModel
from .model_validation import reject_credentials


AttentionStatus = Literal['open', 'resolved', 'cancelled']


class AgentAttentionCreate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    agent_id: str = Field(min_length=1, max_length=128)
    task_id: str | None = Field(default=None, min_length=1, max_length=128)
    idempotency_key: str = Field(min_length=8, max_length=256)
    kind: Literal['question', 'approval', 'review', 'permission', 'blocked']
    title: str = Field(min_length=1, max_length=160)
    detail: str = Field(min_length=1, max_length=4096)
    requested_action: str = Field(min_length=1, max_length=2048)
    options: list[str] | None = Field(default=None, min_length=2, max_length=3)

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        if self.options is not None and (
            len(set(self.options)) != len(self.options)
            or any(not value or len(value) > 160 for value in self.options)
        ):
            raise ValueError('attention options must be distinct non-empty labels up to 160 characters')
        reject_credentials(self, 'Agent attention request')
        return self


class AgentAttentionDecision(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    request_id: str = Field(min_length=1, max_length=128)
    expected_revision: int = Field(ge=0)
    response: str = Field(min_length=1, max_length=4096)

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        reject_credentials(self, 'Agent attention response')
        return self


class AgentAttentionRecord(StrictModel):
    request_id: str
    personal_space_id: str
    personal_project_id: str
    agent_id: str
    task_id: str | None = None
    kind: str
    title: str
    detail: str
    requested_action: str
    options: list[str] | None = None
    status: AttentionStatus = 'open'
    revision: int = 0
    response: str | None = None
    responded_by: Literal['human', 'agent'] | None = None
    created_at: datetime
    updated_at: datetime


class AgentAttentionList(StrictModel):
    items: list[AgentAttentionRecord]
    total: int
    counts: dict[str, int]
