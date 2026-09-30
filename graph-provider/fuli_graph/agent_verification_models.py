from typing import Annotated, Literal
from pydantic import Field
from .models import StrictModel, SourceApplication


class AgentQualityQuery(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    task_id: str = Field(min_length=1, max_length=128)
    artifact_revision: str = Field(min_length=1, max_length=160)


class AgentVerification(AgentQualityQuery):
    run_id: str = Field(min_length=1, max_length=128)
    task_context_token: str = Field(min_length=1, max_length=160)
    source_application: SourceApplication
    attempt_id: str = Field(min_length=8, max_length=128)
    outcome: Literal['pass', 'fail']
    evidence_refs: list[Annotated[str, Field(min_length=1, max_length=512, pattern=r'\S')]] = Field(min_length=1, max_length=12)
    executor_id: str = Field(min_length=1, max_length=128)
    provider: str = Field(min_length=1, max_length=128)
    model: str = Field(min_length=1, max_length=256)
