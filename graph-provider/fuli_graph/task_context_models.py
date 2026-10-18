"""Durable lifecycle metadata, never prompts, local paths or transcripts."""

from typing import Literal

from pydantic import Field, field_validator, model_validator

from .models import SourceApplication, StrictModel
from .model_validation import reject_credentials
from .project_agent_memory_models import ProjectAgentWorkingMemory
from .knowledge_usage_models import KnowledgeUsageItem


class TaskPreferenceScope(StrictModel):
    version: int = Field(strict=True, ge=1, le=1)
    work_kind: str | None = Field(min_length=1, max_length=128)
    workflow: str | None = Field(min_length=1, max_length=128)


class TaskAgentAssignment(StrictModel):
    """The entry's accountability constraints; replayed by same-task recovery."""
    version: int = Field(strict=True, ge=1, le=1)
    selection_reason: str | None = Field(min_length=1, max_length=128)
    match_basis: list[str] = Field(max_length=32)
    requested_agent_id: str | None = Field(min_length=1, max_length=128)
    reporting_lead_agent_id: str | None = Field(min_length=1, max_length=128)
    execution_reason: str | None = Field(min_length=1, max_length=128)
    execution_agent_id: str | None = Field(min_length=1, max_length=128)

    @field_validator('match_basis')
    @classmethod
    def bounded_basis(cls, value):
        if any(not item or len(item) > 2048 for item in value):
            raise ValueError('match_basis items must be 1-2048 characters')
        return value


class TaskContextBegin(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    project_agent_id: str | None = Field(default=None, min_length=1, max_length=128)
    session_id: str = Field(min_length=1, max_length=256)
    source_application: SourceApplication
    source_session_id: str | None = Field(default=None, min_length=1, max_length=256)
    token: str = Field(pattern=r'^fuli-task-[a-zA-Z0-9-]{8,128}$')
    turn_id: str | None = Field(default=None, min_length=1, max_length=256)
    memory_revision: int | None = Field(default=None, ge=0)
    work_log_required: bool = False
    preference_scope: TaskPreferenceScope | None = None
    agent_assignment: TaskAgentAssignment | None = None
    # Private host proof, validated by the Provider and never stored or returned.
    delegation_token: str | None = Field(default=None, min_length=32, max_length=128, exclude=True, repr=False)
    # 'hook' when a lifecycle hook delivered the context, so its Stop hook will
    # run and may close a task that has nothing to record.
    entry_via: Literal['hook', 'tool'] = 'tool'


class TaskContextAgentMemory(StrictModel):
    expected_revision: int = Field(ge=0)
    memory: ProjectAgentWorkingMemory


class TaskPreferenceRead(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    source_application: SourceApplication
    session_id: str = Field(min_length=1, max_length=256)


class TaskContextCoordinationTask(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    source_application: SourceApplication
    task_id: str = Field(min_length=1, max_length=128)


class TaskContextAdoptAgent(TaskContextCoordinationTask):
    agent_id: str = Field(min_length=1, max_length=128)


class TaskWorkLog(StrictModel):
    status: Literal['reported', 'completed', 'incomplete', 'failed', 'no_change', 'unreported']
    summary: str = Field(min_length=1, max_length=2000)

    @field_validator('summary')
    @classmethod
    def require_summary(cls, value):
        if not value.strip():
            raise ValueError('Work summary must not be blank')
        return value.strip()


class TaskCaptureReceipt(StrictModel):
    scope: Literal['personal_global', 'current_project']
    personal_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    status: Literal['committed', 'duplicate', 'capture_disabled']
    episode_id: str | None = Field(default=None, min_length=1, max_length=128)
    entity_ids: list[str] = Field(default_factory=list, max_length=128)
    relationship_ids: list[str] = Field(default_factory=list, max_length=256)

    @model_validator(mode='after')
    def require_matching_scope_and_receipt(self):
        if (self.scope == 'current_project') != bool(self.personal_project_id):
            raise ValueError('capture receipt must match its scope')
        if self.status == 'capture_disabled':
            if self.episode_id or self.entity_ids or self.relationship_ids:
                raise ValueError('disabled capture cannot claim saved items')
        elif not self.episode_id or not self.entity_ids:
            raise ValueError('saved capture requires its Provider receipt')
        if any(not item or len(item) > 128 for item in [*self.entity_ids, *self.relationship_ids]):
            raise ValueError('capture receipt IDs must contain 1 to 128 characters')
        return self


class TaskContextCheckpoint(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    source_application: SourceApplication
    phase: Literal['prepare', 'complete'] = 'complete'
    disposition: Literal['capture_candidates', 'retain_nothing']
    reason: str = Field(min_length=1, max_length=2000)
    fingerprint: str = Field(pattern=r'^[a-f0-9]{64}$')
    capture_status: str | None = Field(default=None, max_length=128)
    capture_results: list[TaskCaptureReceipt] | None = Field(default=None, min_length=1, max_length=2)
    agent_memory: TaskContextAgentMemory | None = None
    work_log: TaskWorkLog | None = None
    knowledge_usage: list[KnowledgeUsageItem] | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        if self.knowledge_usage is not None:
            identities = {(item.item_kind, item.item_id, item.use_kind) for item in self.knowledge_usage}
            if len(identities) != len(self.knowledge_usage):
                raise ValueError('knowledge usage items must be unique')
        if self.agent_memory is not None and self.phase != 'prepare':
            raise ValueError('Agent memory belongs to atomic checkpoint preparation')
        if self.capture_results is not None:
            if self.phase != 'complete' or self.disposition != 'capture_candidates':
                raise ValueError('capture receipts belong to a completed capture checkpoint')
            if len({item.scope for item in self.capture_results}) != len(self.capture_results):
                raise ValueError('capture receipt scopes must be unique')
        reject_credentials(self, 'task checkpoint')
        return self
