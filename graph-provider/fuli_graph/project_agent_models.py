from datetime import datetime
from typing import Literal

from pydantic import AliasChoices, Field, field_validator, model_validator

from .model_validation import reject_credentials, validate_emoji_sequence
from .models import SourceApplication, StrictModel


ProjectAgentStatus = Literal['active', 'inactive', 'archived']
ProjectAgentType = Literal['coordinator', 'durable', 'hr', 'temporary']
ProjectAgentMemoryScope = Literal['reviewed_agent', 'task_only']
ProjectAgentWorkStatus = Literal[
    'idle',
    'awaiting_recruitment',
    'queued',
    'running',
    'paused',
    'failed',
    'awaiting_review',
    'blocked',
    'ended',
]
ProjectAgentAssignmentStatus = Literal['active', 'ended']
ProjectAgentModelMode = Literal['adaptive', 'fast', 'balanced', 'deep']
ProjectAgentReasoningEffort = Literal['default', 'low', 'medium', 'high']
ProjectAgentExecutorPolicyMode = Literal['flexible', 'locked']
PROJECT_AGENT_CLIENTS: tuple[SourceApplication, ...] = (
    'codex',
    'claude_code',
    'cursor',
    'kiro',
    'other',
)


class ProjectAgentModelStrategy(StrictModel):
    """Provider-neutral intent that each client maps to an available model."""

    mode: ProjectAgentModelMode = 'adaptive'
    reasoning_effort: ProjectAgentReasoningEffort = 'default'
    capability_hints: list[str] = Field(default_factory=list, max_length=16)

    @field_validator('capability_hints')
    @classmethod
    def validate_hints(cls, value: list[str]) -> list[str]:
        normalized = [item.strip() for item in value]
        if any(not item or len(item) > 128 for item in normalized):
            raise ValueError('model capability hints must contain 1 to 128 characters')
        if len({item.casefold() for item in normalized}) != len(normalized):
            raise ValueError('model capability hints must be unique')
        return normalized


class ProjectAgentExecutorPolicy(StrictModel):
    """Explicit executor selection policy for an Agent or a Task.

    ``flexible`` is intentionally the safe default: the coordinator may use
    registered executors that pass all workspace checks.  ``locked`` is an
    explicit allow-list; selection may stay within that list, but an
    unavailable list must block rather than silently falling back outside it.
    """

    mode: ProjectAgentExecutorPolicyMode = 'flexible'
    locked_executor_ids: list[str] = Field(default_factory=list, max_length=32)
    preferred_executor_ids: list[str] = Field(default_factory=list, max_length=32)

    @field_validator('locked_executor_ids', 'preferred_executor_ids')
    @classmethod
    def validate_executor_ids(cls, value: list[str]) -> list[str]:
        normalized = [item.strip() for item in value]
        if any(not item or len(item) > 128 for item in normalized):
            raise ValueError('executor IDs must contain 1 to 128 characters')
        if len(set(normalized)) != len(normalized):
            raise ValueError('executor IDs must be unique')
        return normalized

    @model_validator(mode='after')
    def validate_mode(self):
        if self.mode == 'locked' and not self.locked_executor_ids:
            raise ValueError('locked executor policy requires an explicit allow-list')
        if self.mode == 'locked' and self.preferred_executor_ids:
            raise ValueError('locked executor policy cannot contain flexible preferences')
        if set(self.locked_executor_ids) & set(self.preferred_executor_ids):
            raise ValueError('locked and preferred executor IDs must not overlap')
        reject_credentials(self, 'Project Agent executor policy')
        return self


class ProjectAgentProfile(StrictModel):
    name: str = Field(min_length=1, max_length=160)
    # Keep the visual occupation marker as first-class profile data.  It is
    # intentionally independent from ``name`` so clients can update either
    # value without rewriting the other and old profiles can omit it.
    occupation_emoji: str | None = Field(
        default=None,
        min_length=1,
        max_length=32,
        validation_alias=AliasChoices('occupation_emoji', 'occupationEmoji'),
    )
    responsibility: str = Field(min_length=1, max_length=4096)
    agent_type: ProjectAgentType = 'durable'
    work_kinds: list[str] = Field(default_factory=list, max_length=32)
    capabilities: list[str] = Field(default_factory=list, max_length=32)
    initial_preferences: list[str] = Field(default_factory=list, max_length=32)
    default_model_strategy: ProjectAgentModelStrategy = Field(
        default_factory=ProjectAgentModelStrategy
    )
    executor_policy: ProjectAgentExecutorPolicy = Field(
        default_factory=ProjectAgentExecutorPolicy
    )
    allowed_clients: list[SourceApplication] = Field(
        default_factory=lambda: list(PROJECT_AGENT_CLIENTS),
        max_length=len(PROJECT_AGENT_CLIENTS),
    )
    test_source: str | None = Field(default=None, min_length=1, max_length=256)
    cleanup_eligible: bool = False
    status: ProjectAgentStatus = 'active'

    @field_validator('occupation_emoji', mode='before')
    @classmethod
    def validate_occupation_emoji(cls, value):
        return validate_emoji_sequence(value, 'occupation emoji')

    @field_validator('work_kinds', 'capabilities', 'initial_preferences')
    @classmethod
    def validate_bounded_unique_text(cls, value: list[str]) -> list[str]:
        normalized = [item.strip() for item in value]
        if any(not item or len(item) > 512 for item in normalized):
            raise ValueError(
                'project Agent list entries must contain 1 to 512 characters'
            )
        if len({item.casefold() for item in normalized}) != len(normalized):
            raise ValueError('project Agent list entries must be unique')
        return normalized

    @field_validator('allowed_clients')
    @classmethod
    def validate_unique_clients(
        cls,
        value: list[SourceApplication],
    ) -> list[SourceApplication]:
        if len(set(value)) != len(value):
            raise ValueError('allowed clients must be unique')
        return value

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        reject_credentials(self, 'Project Agent profile')
        return self


class ProjectAgentUpsert(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    # Kept optional for backwards-compatible callers. The Agent identity is
    # space-level; project responsibility lives in explicit assignments.
    personal_project_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
    )
    agent_id: str = Field(min_length=1, max_length=128)
    profile: ProjectAgentProfile


class ProjectAgentAssignmentCreate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    agent_id: str = Field(min_length=1, max_length=128)
    idempotency_key: str = Field(min_length=8, max_length=256)
    responsibility: str = Field(min_length=1, max_length=4096)
    work_kinds: list[str] = Field(default_factory=list, max_length=32)
    capabilities: list[str] = Field(default_factory=list, max_length=32)
    model_strategy_override: ProjectAgentModelStrategy | None = None
    executor_policy_override: ProjectAgentExecutorPolicy | None = None
    reason: str = Field(min_length=1, max_length=2048)
    source_application: SourceApplication | None = None
    source_session_id: str | None = Field(default=None, min_length=1, max_length=256)

    @field_validator('work_kinds', 'capabilities')
    @classmethod
    def validate_bounded_unique_text(cls, value: list[str]) -> list[str]:
        return ProjectAgentProfile.validate_bounded_unique_text(value)

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        reject_credentials(self, 'Project Agent assignment')
        return self


class ProjectAgentAssignmentRecord(StrictModel):
    assignment_id: str
    personal_space_id: str
    personal_project_id: str
    agent_id: str
    responsibility: str
    work_kinds: list[str] = Field(default_factory=list)
    capabilities: list[str] = Field(default_factory=list)
    model_strategy_override: ProjectAgentModelStrategy | None = None
    executor_policy_override: ProjectAgentExecutorPolicy | None = None
    reason: str
    status: ProjectAgentAssignmentStatus
    revision: int = Field(default=0, ge=0)
    source_application: SourceApplication | None = None
    source_session_id: str | None = None
    assigned_at: datetime
    updated_at: datetime
    ended_at: datetime | None = None
    end_reason: str | None = None
    replaced_by_assignment_id: str | None = None


class ProjectAgentAssignmentEnd(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    assignment_id: str = Field(min_length=1, max_length=128)
    expected_revision: int = Field(ge=0)
    reason: str = Field(min_length=1, max_length=2048)

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        reject_credentials(self, 'Project Agent assignment end')
        return self


class ProjectAgentAssignmentReplace(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    assignment_id: str = Field(min_length=1, max_length=128)
    expected_revision: int = Field(ge=0)
    replacement_agent_id: str = Field(min_length=1, max_length=128)
    idempotency_key: str = Field(min_length=8, max_length=256)
    responsibility: str = Field(min_length=1, max_length=4096)
    work_kinds: list[str] = Field(default_factory=list, max_length=32)
    capabilities: list[str] = Field(default_factory=list, max_length=32)
    model_strategy_override: ProjectAgentModelStrategy | None = None
    executor_policy_override: ProjectAgentExecutorPolicy | None = None
    reason: str = Field(min_length=1, max_length=2048)
    source_application: SourceApplication | None = None
    source_session_id: str | None = Field(default=None, min_length=1, max_length=256)

    @field_validator('work_kinds', 'capabilities')
    @classmethod
    def validate_bounded_unique_text(cls, value: list[str]) -> list[str]:
        return ProjectAgentProfile.validate_bounded_unique_text(value)

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        reject_credentials(self, 'Project Agent assignment replacement')
        return self


class ProjectAgentAssignmentReplaceResult(StrictModel):
    ended: ProjectAgentAssignmentRecord
    replacement: ProjectAgentAssignmentRecord


class ProjectAgentRecord(StrictModel):
    agent_id: str
    personal_space_id: str
    personal_project_id: str | None = None
    profile: ProjectAgentProfile
    executor_policy: ProjectAgentExecutorPolicy = Field(
        default_factory=ProjectAgentExecutorPolicy
    )
    memory_scope: ProjectAgentMemoryScope = 'reviewed_agent'
    assignments: list[ProjectAgentAssignmentRecord] = Field(default_factory=list)
    recruitment_id: str | None = None
    temporary_task_id: str | None = None
    work_status: ProjectAgentWorkStatus = 'idle'
    open_task_count: int = Field(default=0, ge=0)
    current_task_id: str | None = None
    observed_clients: list[SourceApplication] = Field(default_factory=list)
    recruited_at: datetime | None = None
    recruitment_reason: str | None = None
    recruitment_source_application: SourceApplication | None = None
    created_at: datetime
    updated_at: datetime
