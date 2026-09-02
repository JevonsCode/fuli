from datetime import date, datetime
from typing import Literal

from pydantic import AliasChoices, Field, field_validator, model_validator

from .model_validation import (
    normalize_source_session_url,
    reject_credentials,
    validate_emoji_sequence,
)
from .models import SourceApplication, StrictModel
from .project_agent_models import (
    ProjectAgentExecutorPolicy,
    ProjectAgentModelStrategy,
    ProjectAgentProfile,
    ProjectAgentRecord,
)


ProjectAgentTaskDuration = Literal['ongoing', 'one_off']
ProjectAgentStaffingIntent = Literal[
    'reuse_preferred',
    'new_durable',
    'temporary',
    'unassigned',
]
ProjectAgentTaskStatus = Literal[
    'awaiting_recruitment',
    'queued',
    'running',
    'paused',
    'failed',
    'awaiting_review',
    'blocked',
    'completed',
    'cancelled',
]
ProjectAgentParticipantRole = Literal['lead', 'collaborator']
ProjectAgentRoutingOutcome = Literal[
    'assigned_existing',
    'recruited',
    'unassigned',
    'recruitment_required',
    'blocked',
]
ProjectAgentRoutingReason = Literal[
    'explicit_agent',
    'project_continuity',
    'project_default',
    'sole_active_assignment',
    'manual_agent_selection',
    'exact_work_kind',
    'exact_capability',
    'no_match',
    'agent_unavailable',
    'explicit_new_agent',
    'explicit_temporary_agent',
    'explicit_unassigned',
    'hr_unavailable',
]
ProjectAgentPositionKind = Literal['durable', 'temporary']
ProjectAgentRecruitmentStatus = Literal[
    'awaiting_confirmation',
    'requested',
    'fulfilled',
    'cancelled',
    'blocked',
    'no_hr',
]
ProjectAgentRecruitmentConfirmationMode = Literal[
    'automatic',
    'require_confirmation',
]
ProjectAgentTaskComplexity = Literal['simple', 'standard', 'complex']
ProjectAgentOptimizationPriority = Literal[
    'quality_and_acceptance',
    'token_and_cost',
    'time',
]
ProjectAgentTokenUsageSource = Literal['executor', 'host', 'dingdong']

_WORKER_EVIDENCE_ALIASES = {
    'worker_id': 'workerId',
    'worker_label': 'workerLabel',
    'worker_occupation_emoji': 'workerOccupationEmoji',
    'worker_status': 'workerStatus',
    'token_usage': 'tokenUsage',
    'worker_runtime': 'workerRuntime',
}


def _unique_text(value: list[str], label: str) -> list[str]:
    normalized = [item.strip() for item in value]
    if any(not item or len(item) > 512 for item in normalized):
        raise ValueError(f'{label} must contain 1 to 512 characters')
    if len({item.casefold() for item in normalized}) != len(normalized):
        raise ValueError(f'{label} must be unique')
    return normalized


def _normalize_worker_evidence_aliases(value):
    if not isinstance(value, dict):
        return value
    normalized = dict(value)
    for field_name, alias in _WORKER_EVIDENCE_ALIASES.items():
        if alias not in normalized:
            continue
        if field_name in normalized and normalized[field_name] != normalized[alias]:
            raise ValueError(f'conflicting {field_name} and {alias} values')
        normalized[field_name] = normalized.pop(alias)
    return normalized


class ProjectAgentParallelPlan(StrictModel):
    enabled: bool = False
    independent_verification: bool = False
    conflict_free_scopes: bool = False
    reason: str | None = Field(default=None, min_length=1, max_length=2048)
    workstream_boundaries: list[str] = Field(default_factory=list, max_length=16)

    @field_validator('workstream_boundaries')
    @classmethod
    def validate_boundaries(cls, value: list[str]) -> list[str]:
        return _unique_text(value, 'parallel workstream boundaries')

    @model_validator(mode='after')
    def validate_parallel_plan(self):
        if self.enabled and not (
            self.independent_verification
            and self.conflict_free_scopes
            and self.reason
            and len(self.workstream_boundaries) >= 2
        ):
            raise ValueError(
                'parallel work requires independent verification, conflict-free '
                'scopes, a reason, and at least two workstream boundaries'
            )
        if not self.enabled and self.workstream_boundaries:
            raise ValueError('disabled parallel plan cannot contain workstreams')
        return self


class ProjectAgentTaskSubmit(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    idempotency_key: str = Field(min_length=8, max_length=256)
    title: str = Field(min_length=1, max_length=160)
    objective: str = Field(min_length=1, max_length=4096)
    work_kind: str = Field(min_length=1, max_length=128)
    required_capabilities: list[str] = Field(default_factory=list, max_length=16)
    executor_capability_hints: list[str] = Field(
        default_factory=list,
        max_length=16,
    )
    duration: ProjectAgentTaskDuration = 'ongoing'
    staffing_intent: ProjectAgentStaffingIntent = 'reuse_preferred'
    lead_agent_id: str | None = Field(default=None, min_length=1, max_length=128)
    collaborator_agent_ids: list[str] = Field(default_factory=list, max_length=16)
    coordinator_agent_id: str | None = Field(default=None, min_length=1, max_length=128)
    complexity_hint: ProjectAgentTaskComplexity | None = None
    parallel_plan: ProjectAgentParallelPlan = Field(
        default_factory=ProjectAgentParallelPlan
    )
    model_strategy_override: ProjectAgentModelStrategy | None = None
    executor_policy_override: ProjectAgentExecutorPolicy | None = None
    # Compatibility spelling used by the task store's executor hook.
    executor_override: ProjectAgentExecutorPolicy | None = None
    source_application: SourceApplication | None = None
    source_session_id: str | None = Field(default=None, min_length=1, max_length=256)
    routing_reason: str = Field(min_length=1, max_length=2048)
    recruitment_profile: ProjectAgentProfile | None = None

    @field_validator('required_capabilities')
    @classmethod
    def validate_capabilities(cls, value: list[str]) -> list[str]:
        return _unique_text(value, 'required capabilities')

    @field_validator('executor_capability_hints')
    @classmethod
    def validate_executor_capability_hints(
        cls,
        value: list[str],
    ) -> list[str]:
        return _unique_text(value, 'executor capability hints')

    @field_validator('collaborator_agent_ids')
    @classmethod
    def validate_collaborators(cls, value: list[str]) -> list[str]:
        return _unique_text(value, 'collaborator Agent IDs')

    @model_validator(mode='after')
    def validate_staffing(self):
        if self.lead_agent_id and self.staffing_intent not in {
            'reuse_preferred',
        }:
            raise ValueError(
                'explicit lead Agent requires reuse_preferred staffing intent'
            )
        if self.lead_agent_id in self.collaborator_agent_ids:
            raise ValueError('lead Agent cannot also be a collaborator')
        # The coordinator may fill missing collaborators from qualified durable
        # assignments; the final participant minimum is checked after routing.
        if self.staffing_intent == 'temporary' and self.duration != 'one_off':
            raise ValueError('temporary staffing requires a one-off task')
        if (
            self.recruitment_profile
            and self.recruitment_profile.agent_type != 'durable'
        ):
            raise ValueError('recruitment profile agent_type must be durable input')
        if self.executor_policy_override and self.executor_override:
            raise ValueError(
                'executor_policy_override and executor_override are mutually exclusive'
            )
        reject_credentials(self, 'project Agent task')
        return self


class ProjectAgentTaskParticipantRecord(StrictModel):
    agent_id: str
    role: ProjectAgentParticipantRole
    status: ProjectAgentTaskStatus
    assignment_summary: str | None = None
    joined_at: datetime
    updated_at: datetime
    ended_at: datetime | None = None


class ProjectAgentTokenUsage(StrictModel):
    """Cumulative token snapshot reported for one concrete worker run."""

    source: ProjectAgentTokenUsageSource
    total_tokens: int = Field(
        ge=0,
        validation_alias=AliasChoices('total_tokens', 'totalTokens'),
    )
    input_tokens: int | None = Field(
        default=None,
        ge=0,
        validation_alias=AliasChoices('input_tokens', 'inputTokens'),
    )
    output_tokens: int | None = Field(
        default=None,
        ge=0,
        validation_alias=AliasChoices('output_tokens', 'outputTokens'),
    )
    cached_input_tokens: int | None = Field(
        default=None,
        ge=0,
        validation_alias=AliasChoices(
            'cached_input_tokens',
            'cachedInputTokens',
        ),
    )
    cache_write_input_tokens: int | None = Field(
        default=None,
        ge=0,
        validation_alias=AliasChoices(
            'cache_write_input_tokens',
            'cacheWriteInputTokens',
        ),
    )
    reasoning_output_tokens: int | None = Field(
        default=None,
        ge=0,
        validation_alias=AliasChoices(
            'reasoning_output_tokens',
            'reasoningOutputTokens',
        ),
    )


class ProjectAgentWorkerRuntime(StrictModel):
    """Host-reported worker location, never the reporter's trusted identity."""

    application: SourceApplication
    session_id: str | None = Field(
        default=None, min_length=1, max_length=256,
        validation_alias=AliasChoices('session_id', 'sessionId'),
    )
    session_url: str | None = Field(
        default=None, max_length=2048,
        validation_alias=AliasChoices('session_url', 'sessionUrl'),
    )

    _validate_session_url = field_validator('session_url')(
        normalize_source_session_url
    )

    @field_validator('session_id')
    @classmethod
    def validate_session_id(cls, value):
        if value is not None and not value.strip():
            raise ValueError('worker session ID must not be blank')
        return value.strip() if value is not None else None

    @model_validator(mode='after')
    def validate_evidence(self):
        reject_credentials(self, 'worker runtime')
        return self


class ProjectAgentTaskExecutionSummary(StrictModel):
    """Auditable execution evidence projected onto a real task participant.

    The participant identity is durable Agent data; the optional worker fields
    identify a concrete subagent run when a client reports one.  None means the
    provider did not observe that fact and must not infer it from routing
    configuration.
    """

    agent_id: str
    agent_name: str | None = None
    occupation_emoji: str | None = None
    participant_role: ProjectAgentParticipantRole
    executor: str | None = None
    executor_id: str | None = None
    source_application: SourceApplication | None = None
    actual_model_provider: str | None = None
    actual_model: str | None = None
    source_session_id: str | None = None
    source_session_url: str | None = None
    tools_used: list[str] | None = Field(default=None, max_length=32)
    token_usage: ProjectAgentTokenUsage | None = None
    work_summary: str | None = None
    status: ProjectAgentTaskStatus
    worker_id: str | None = None
    worker_label: str | None = None
    worker_occupation_emoji: str | None = None
    worker_runtime: ProjectAgentWorkerRuntime | None = None

    @field_validator('occupation_emoji', 'worker_occupation_emoji', mode='before')
    @classmethod
    def validate_emojis(cls, value):
        return validate_emoji_sequence(value, 'occupation emoji')

    _validate_session_url = field_validator('source_session_url')(
        normalize_source_session_url
    )

    @field_validator('tools_used')
    @classmethod
    def validate_tools_used(cls, value):
        return _unique_text(value, 'tools used') if value is not None else None


class ProjectAgentTaskEventRecord(StrictModel):
    event_id: str
    task_id: str
    agent_id: str | None = None
    status: ProjectAgentTaskStatus
    actor_kind: Literal['agent', 'human', 'system', 'hr']
    summary: str
    source_application: SourceApplication | None = None
    source_session_id: str | None = None
    source_session_url: str | None = None
    tools_used: list[str] | None = Field(default=None, max_length=32)
    actual_model_provider: str | None = None
    actual_model: str | None = None
    actual_executor_id: str | None = None
    executor_rule_id: str | None = None
    matched_executor_rule_id: str | None = None
    executor_selection_reason: str | None = None
    executor_fallback_reason: str | None = None
    executor_blocked_reason: str | None = None
    worker_id: str | None = None
    worker_label: str | None = None
    worker_occupation_emoji: str | None = None
    worker_status: ProjectAgentTaskStatus | None = None
    token_usage: ProjectAgentTokenUsage | None = None
    worker_runtime: ProjectAgentWorkerRuntime | None = None
    created_at: datetime

    _normalize_worker_aliases = model_validator(mode='before')(
        _normalize_worker_evidence_aliases
    )

    @field_validator('worker_occupation_emoji', mode='before')
    @classmethod
    def validate_worker_occupation_emoji(cls, value):
        return validate_emoji_sequence(value, 'worker occupation emoji')

    _validate_session_url = field_validator('source_session_url')(
        normalize_source_session_url
    )

    @field_validator('tools_used')
    @classmethod
    def validate_tools_used(cls, value):
        return _unique_text(value, 'tools used') if value is not None else None


class ProjectAgentRoutingDecisionRecord(StrictModel):
    decision_id: str
    task_id: str
    coordinator_agent_id: str
    complexity: ProjectAgentTaskComplexity
    complexity_basis: list[str] = Field(default_factory=list)
    selected_model_strategy: ProjectAgentModelStrategy | None = None
    model_strategy_source: Literal['agent', 'assignment', 'task', 'coordinator']
    outcome: ProjectAgentRoutingOutcome
    reason: ProjectAgentRoutingReason
    match_basis: list[str] = Field(default_factory=list)
    candidate_agent_ids: list[str] = Field(default_factory=list)
    optimization_priority: list[ProjectAgentOptimizationPriority] = Field(
        default_factory=lambda: [
            'quality_and_acceptance',
            'token_and_cost',
            'time',
        ]
    )
    parallel_plan: ProjectAgentParallelPlan = Field(
        default_factory=ProjectAgentParallelPlan
    )
    selected_executor_id: str | None = None
    executor_rule_id: str | None = None
    matched_executor_rule_id: str | None = None
    executor_selection_reason: str | None = None
    executor_fallback_outcome: str | None = None
    executor_blocked_reason: str | None = None
    executor_decision: dict[str, object] | None = None
    executor_policy: ProjectAgentExecutorPolicy = Field(
        default_factory=ProjectAgentExecutorPolicy
    )
    created_at: datetime


class ProjectAgentTaskRecord(StrictModel):
    task_id: str
    personal_space_id: str
    personal_project_id: str
    title: str
    objective: str
    work_kind: str
    required_capabilities: list[str]
    executor_capability_hints: list[str] = Field(default_factory=list)
    duration: ProjectAgentTaskDuration
    staffing_intent: ProjectAgentStaffingIntent
    status: ProjectAgentTaskStatus
    revision: int = Field(ge=0)
    routing_outcome: ProjectAgentRoutingOutcome
    routing_reason: ProjectAgentRoutingReason
    routing_explanation: str
    match_basis: list[str] = Field(default_factory=list)
    coordinator_agent_id: str
    complexity: ProjectAgentTaskComplexity
    complexity_basis: list[str] = Field(default_factory=list)
    routing_decision: ProjectAgentRoutingDecisionRecord
    lead_agent_id: str | None = None
    participants: list[ProjectAgentTaskParticipantRecord] = Field(default_factory=list)
    execution_summary: list[ProjectAgentTaskExecutionSummary] = Field(
        default_factory=list,
        validation_alias=AliasChoices('execution_summary', 'executionSummary'),
    )
    effective_model_strategy: ProjectAgentModelStrategy | None = None
    model_strategy_source: Literal[
        'agent',
        'assignment',
        'task',
        'coordinator',
    ] = 'coordinator'
    executor_policy: ProjectAgentExecutorPolicy = Field(
        default_factory=ProjectAgentExecutorPolicy
    )
    selected_executor_id: str | None = None
    executor_rule_id: str | None = None
    actual_run_id: str | None = None
    actual_executor_id: str | None = None
    actual_model_provider: str | None = None
    actual_model: str | None = None
    matched_executor_rule_id: str | None = None
    executor_selection_reason: str | None = None
    executor_fallback_outcome: str | None = None
    executor_fallback_reason: str | None = None
    executor_blocked_reason: str | None = None
    executor_decision: dict[str, object] | None = None
    hr_agent_id: str | None = None
    recruitment_id: str | None = None
    source_application: SourceApplication | None = None
    source_session_id: str | None = None
    result_summary: str | None = None
    failure_reason: str | None = None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None
    events: list[ProjectAgentTaskEventRecord] = Field(default_factory=list)


class ProjectAgentTaskActivityCreate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    task_id: str = Field(min_length=1, max_length=128)
    idempotency_key: str = Field(min_length=8, max_length=256)
    expected_revision: int | None = Field(default=None, ge=0)
    status: ProjectAgentTaskStatus
    summary: str = Field(min_length=1, max_length=4096)
    agent_id: str | None = Field(default=None, min_length=1, max_length=128)
    actor_kind: Literal['agent', 'human'] = 'agent'
    source_application: SourceApplication | None = None
    source_session_id: str | None = Field(default=None, min_length=1, max_length=256)
    source_session_url: str | None = Field(default=None, max_length=2048)
    tools_used: list[str] | None = Field(default=None, max_length=32)
    actual_model_provider: str | None = Field(default=None, min_length=1, max_length=128)
    actual_model: str | None = Field(default=None, min_length=1, max_length=256)
    actual_executor_id: str | None = Field(default=None, min_length=1, max_length=128)
    matched_executor_rule_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
    )
    executor_selection_reason: str | None = Field(
        default=None,
        min_length=1,
        max_length=2048,
    )
    executor_fallback_reason: str | None = Field(
        default=None,
        min_length=1,
        max_length=2048,
    )
    executor_blocked_reason: str | None = Field(
        default=None,
        min_length=1,
        max_length=2048,
    )
    worker_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
    )
    worker_label: str | None = Field(
        default=None,
        min_length=1,
        max_length=160,
    )
    worker_occupation_emoji: str | None = Field(
        default=None,
        min_length=1,
        max_length=32,
    )
    worker_status: ProjectAgentTaskStatus | None = None
    token_usage: ProjectAgentTokenUsage | None = None
    worker_runtime: ProjectAgentWorkerRuntime | None = None

    _normalize_worker_aliases = model_validator(mode='before')(
        _normalize_worker_evidence_aliases
    )

    @property
    def reported_client_applications(self):
        # Worker claims can impose another restriction, never replace the
        # host identity used for authorization and audit attribution.
        return (self.source_application, self.worker_runtime.application) \
            if self.worker_runtime else (self.source_application,)

    @field_validator('worker_occupation_emoji', mode='before')
    @classmethod
    def validate_worker_occupation_emoji(cls, value):
        return validate_emoji_sequence(value, 'worker occupation emoji')

    _validate_session_url = field_validator('source_session_url')(
        normalize_source_session_url
    )

    @field_validator('tools_used')
    @classmethod
    def validate_tools_used(cls, value):
        return _unique_text(value, 'tools used') if value is not None else None

    @model_validator(mode='after')
    def validate_actual_model(self):
        if self.status in {'completed', 'failed'} and not self.agent_id:
            raise ValueError(
                'completed or failed activity requires the participating Agent ID'
            )
        if bool(self.actual_model_provider) != bool(self.actual_model):
            raise ValueError('actual model provider and model must be reported together')
        if bool(self.actual_executor_id) != bool(self.actual_model):
            raise ValueError(
                'actual executor, model provider, and model must be reported together'
            )
        if self.actual_executor_id and not self.agent_id:
            raise ValueError('actual execution report requires the participating Agent ID')
        if self.worker_id and not self.agent_id:
            raise ValueError('worker execution report requires the participating Agent ID')
        if self.worker_status and not self.worker_id:
            raise ValueError('worker status requires a worker ID')
        if self.worker_runtime and not self.worker_id:
            raise ValueError('worker runtime requires a worker ID')
        if self.token_usage and not self.agent_id:
            raise ValueError('token usage report requires the participating Agent ID')
        if (self.source_session_url or self.tools_used) and not self.agent_id:
            raise ValueError(
                'execution evidence requires the participating Agent ID'
            )
        if (
            self.token_usage
            and self.token_usage.source == 'executor'
            and not self.actual_executor_id
        ):
            raise ValueError(
                'executor token usage requires the actual executor report'
            )
        if (self.worker_label or self.worker_occupation_emoji) and not self.worker_id:
            raise ValueError(
                'worker label or occupation emoji requires a worker ID'
            )
        reject_credentials(self, 'project Agent task activity')
        return self


class ProjectAgentRecruitmentRecord(StrictModel):
    recruitment_id: str
    personal_space_id: str
    personal_project_id: str
    task_id: str
    coordinator_agent_id: str
    hr_agent_id: str | None = None
    position_kind: ProjectAgentPositionKind
    work_kind: str
    required_capabilities: list[str]
    reason_code: ProjectAgentRoutingReason
    reason: str
    status: ProjectAgentRecruitmentStatus
    confirmation_mode: ProjectAgentRecruitmentConfirmationMode
    proposed_agent_id: str
    proposed_profile: ProjectAgentProfile
    participant_role: ProjectAgentParticipantRole = 'lead'
    recruitment_slot: str = Field(default='lead', min_length=1, max_length=128)
    trigger_source_application: SourceApplication | None = None
    trigger_source_session_id: str | None = None
    revision: int = Field(ge=0)
    recruited_agent_id: str | None = None
    test_source: str | None = Field(default=None, min_length=1, max_length=256)
    cleanup_eligible: bool = False
    created_at: datetime
    updated_at: datetime
    fulfilled_at: datetime | None = None


class ProjectAgentTaskRouteResult(StrictModel):
    task: ProjectAgentTaskRecord
    assigned_agent: ProjectAgentRecord | None = None
    recruitment: ProjectAgentRecruitmentRecord | None = None
    recruitments: list[ProjectAgentRecruitmentRecord] = Field(default_factory=list)
    decision: Literal[
        'reused',
        'recruited',
        'unassigned',
        'awaiting_confirmation',
        'blocked',
    ]
    must_disclose_recruitment: bool = False
    client_notice: str | None = None


class ProjectAgentRecruitmentPolicyRecord(StrictModel):
    personal_space_id: str
    confirmation_mode: ProjectAgentRecruitmentConfirmationMode = 'automatic'
    updated_at: datetime | None = None
    policy_status: Literal['superseded'] = 'superseded'
    applies_to_recruitment: Literal[False] = False
    warning: str = (
        'Legacy storage only; this setting does not control recruitment. '
        'Use update_project_agent_coordination_policy with the exact project '
        'and askBeforeRecruitment to change effective authorization.'
    )


class ProjectAgentRecruitmentPolicyUpdate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    confirmation_mode: ProjectAgentRecruitmentConfirmationMode


class ProjectAgentRecruitmentDecision(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    recruitment_id: str = Field(min_length=1, max_length=128)
    expected_revision: int = Field(ge=0)
    decision: Literal['approve', 'cancel']
    reason: str = Field(min_length=1, max_length=4096)

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        reject_credentials(self, 'project Agent recruitment decision')
        return self


class ProjectAgentActivityTask(StrictModel):
    task_id: str
    title: str
    status: Literal['completed', 'failed', 'cancelled']
    summary: str
    occurred_at: datetime
    source_application: SourceApplication | None = None
    actual_model_provider: str | None = None
    actual_model: str | None = None
    actual_executor_id: str | None = None
    source_session_id: str | None = None
    source_session_url: str | None = Field(default=None, max_length=2048)
    tools_used: list[str] | None = Field(default=None, max_length=32)
    token_usage: ProjectAgentTokenUsage | None = None
    worker_runtime: ProjectAgentWorkerRuntime | None = None
    matched_executor_rule_id: str | None = None
    worker_id: str | None = None
    worker_label: str | None = None
    worker_occupation_emoji: str | None = None
    worker_status: ProjectAgentTaskStatus | None = None

    _validate_session_url = field_validator('source_session_url')(
        normalize_source_session_url
    )

    @field_validator('tools_used')
    @classmethod
    def validate_tools_used(cls, value):
        return _unique_text(value, 'tools used') if value is not None else None


class ProjectAgentActivityDay(StrictModel):
    date: date
    completed: int = Field(default=0, ge=0)
    failed: int = Field(default=0, ge=0)
    cancelled: int = Field(default=0, ge=0)
    total: int = Field(default=0, ge=0)
    tasks: list[ProjectAgentActivityTask] = Field(default_factory=list)


class ProjectAgentActivityResult(StrictModel):
    agent_id: str
    personal_space_id: str
    from_date: date
    to_date: date
    days: list[ProjectAgentActivityDay] = Field(default_factory=list)
