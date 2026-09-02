from datetime import datetime
from typing import Literal

from pydantic import Field

from .models import StrictModel


class WorkflowObservedStep(StrictModel):
    action_id: str = Field(min_length=1, max_length=256)
    name: str = Field(min_length=1, max_length=512)
    summary: str | None = Field(default=None, min_length=1, max_length=4096)


class WorkflowTransitionObservation(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    host_session_id: str = Field(min_length=1, max_length=256)
    observation_id: str = Field(min_length=8, max_length=256)
    from_step: WorkflowObservedStep
    to_step: WorkflowObservedStep
    workflow_key: str = Field(min_length=1, max_length=256)
    condition: dict[str, object] = Field(default_factory=dict)
    observed_at: datetime
    evidence_summary: str = Field(min_length=1, max_length=2048)
    source_application: Literal[
        'codex', 'claude', 'claude_code', 'cursor', 'kiro', 'other'
    ] | None = None
    source_turn_id: str | None = Field(default=None, min_length=1, max_length=256)
    sensitivity: Literal['normal', 'private', 'restricted'] = 'normal'
