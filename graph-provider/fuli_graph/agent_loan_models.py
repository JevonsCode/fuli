"""Explicit task-scoped specialist loans between project team leads."""
from typing import Literal
from pydantic import Field
from .models import StrictModel, SourceApplication


class AgentLoanRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    task_context_token: str = Field(min_length=1, max_length=160)
    source_application: SourceApplication
    source_project_id: str = Field(min_length=1, max_length=128)
    specialist_id: str = Field(min_length=1, max_length=128)
    target_task_id: str = Field(min_length=1, max_length=128)
    objective: str = Field(min_length=1, max_length=2000)
    idempotency_key: str = Field(min_length=8, max_length=128)


class AgentLoanDecision(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    task_context_token: str = Field(min_length=1, max_length=160)
    source_application: SourceApplication
    loan_id: str = Field(min_length=1, max_length=128)
    decision: Literal['approve', 'reject', 'close']


class AgentLoanQuery(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
