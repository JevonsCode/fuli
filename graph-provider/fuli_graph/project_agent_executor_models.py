"""Durable executor-directory and routing contracts for Project Agents.

The executor layer deliberately stores capabilities and observed availability,
not a hard-coded mapping from a work kind to a tool or vendor.  A coordinator
can only select an executor after the directory, workspace permission,
preflight, capability, and (when required) health checks all pass.
"""

import hashlib
import json
from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator, model_validator

from .model_validation import reject_credentials
from .models import SourceApplication, StrictModel
from .project_agent_models import (
    ProjectAgentExecutorPolicy,
    ProjectAgentModelStrategy,
)


ProjectAgentExecutorRegistrationStatus = Literal[
    'registered',
    'disabled',
    'revoked',
]
ProjectAgentExecutorPermissionStatus = Literal[
    'pending',
    'authorized',
    'denied',
    'revoked',
]
ProjectAgentExecutorPreflightStatus = Literal[
    'not_run',
    'passed',
    'failed',
    'expired',
]
ProjectAgentExecutorHealthStatus = Literal[
    'unknown',
    'healthy',
    'degraded',
    'unhealthy',
]
ProjectAgentExecutorScope = Literal['global', 'space', 'project', 'task']
ProjectAgentExecutorRuleStatus = Literal['active', 'disabled', 'ended']
ProjectAgentExecutorSelectionStatus = Literal[
    'selected',
    'fallback',
    'blocked',
    'unavailable',
]
ProjectAgentExecutorFallbackOutcome = Literal[
    'not_needed',
    'same_rule_candidate',
    'global_priority',
    'blocked_locked',
    'blocked_no_candidate',
]
ProjectAgentExecutorEvidenceKind = Literal[
    'terminal_outcome',
    'rework_requested',
    'repeated_negative_feedback',
    'explicit_praise',
    'test_passed',
    'test_failed',
    'acceptance_passed',
    'acceptance_failed',
    'explicit_rating',
]
ProjectAgentExecutorEvidenceSource = Literal[
    'system_terminal',
    'user_explicit',
    'test_fact',
]
ProjectAgentExecutorTerminalOutcome = Literal[
    'completed',
    'failed',
    'cancelled',
]


def project_agent_model_strategy_key(
    strategy: ProjectAgentModelStrategy,
) -> str:
    """Return the canonical, provider-neutral key for a model strategy."""

    payload = strategy.model_dump(mode='json')
    # Capability hints are a set of requirements, not an ordered preference.
    # Canonicalizing them prevents equivalent provider-neutral strategies from
    # creating separate evidence/aggregate buckets.
    payload['capability_hints'] = sorted(
        (value.casefold() for value in payload.get('capability_hints', [])),
    )
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
    ).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def _unique_text(value: list[str], label: str, *, maximum: int = 512) -> list[str]:
    normalized = [item.strip() for item in value]
    if any(not item or len(item) > maximum for item in normalized):
        raise ValueError(f'{label} must contain 1 to {maximum} characters')
    if len({item.casefold() for item in normalized}) != len(normalized):
        raise ValueError(f'{label} must be unique')
    return normalized


def _unique_ids(value: list[str], label: str = 'IDs') -> list[str]:
    return _unique_text(value, label, maximum=128)


class ProjectAgentExecutorModelRecord(StrictModel):
    """A model actually advertised by an executor preflight.

    ``provider`` and ``model`` are observations from the executor.  Routing
    continues to use the provider-neutral ``ProjectAgentModelStrategy`` and
    these fields are only selected after a preflight reports them available.
    """

    provider: str = Field(min_length=1, max_length=128)
    model: str = Field(min_length=1, max_length=256)
    capabilities: list[str] = Field(default_factory=list, max_length=32)
    strategy_modes: list[Literal['adaptive', 'fast', 'balanced', 'deep']] = Field(
        default_factory=list,
        max_length=4,
    )
    reasoning_efforts: list[Literal['default', 'low', 'medium', 'high']] = Field(
        default_factory=list,
        max_length=4,
    )
    available: bool = True
    observed_at: datetime | None = None
    source_application: SourceApplication | None = None
    unavailable_reason: str | None = Field(default=None, min_length=1, max_length=1024)

    @field_validator('capabilities')
    @classmethod
    def validate_capabilities(cls, value: list[str]) -> list[str]:
        return _unique_text(value, 'executor model capabilities')

    @model_validator(mode='after')
    def validate_availability(self):
        if self.available and self.unavailable_reason:
            raise ValueError('available model cannot have an unavailable reason')
        if not self.available and not self.unavailable_reason:
            raise ValueError('unavailable model requires a reason')
        reject_credentials(self, 'executor model report')
        return self


class ProjectAgentExecutorRegistration(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    executor_id: str = Field(min_length=1, max_length=128)
    display_name: str = Field(min_length=1, max_length=160)
    executor_kind: str = Field(default='external', min_length=1, max_length=128)
    capabilities: list[str] = Field(default_factory=list, max_length=64)
    advertised_models: list[ProjectAgentExecutorModelRecord] = Field(
        default_factory=list,
        max_length=64,
    )
    global_priority: int = Field(default=100, ge=1, le=1_000_000)
    health_required: bool = False
    idempotency_key: str = Field(min_length=8, max_length=256)
    source_application: SourceApplication | None = None
    source_session_id: str | None = Field(default=None, min_length=1, max_length=256)
    test_source: str | None = Field(default=None, min_length=1, max_length=256)
    cleanup_eligible: bool = False
    expected_revision: int | None = Field(default=None, ge=0)

    @field_validator('capabilities')
    @classmethod
    def validate_capabilities(cls, value: list[str]) -> list[str]:
        return _unique_text(value, 'executor capabilities')

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        reject_credentials(self, 'executor registration')
        return self


class ProjectAgentExecutorAuthorization(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    executor_id: str = Field(min_length=1, max_length=128)
    status: ProjectAgentExecutorPermissionStatus
    reason: str = Field(min_length=1, max_length=2048)
    expected_revision: int | None = Field(default=None, ge=0)
    idempotency_key: str = Field(min_length=8, max_length=256)

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        reject_credentials(self, 'executor workspace authorization')
        return self


class ProjectAgentExecutorPreflightReport(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    executor_id: str = Field(min_length=1, max_length=128)
    status: Literal['passed', 'failed']
    workspace_permission: bool
    capabilities: list[str] = Field(default_factory=list, max_length=64)
    available_models: list[ProjectAgentExecutorModelRecord] = Field(
        default_factory=list,
        max_length=64,
    )
    reason: str | None = Field(default=None, min_length=1, max_length=2048)
    checked_at: datetime
    idempotency_key: str = Field(min_length=8, max_length=256)
    source_application: SourceApplication | None = None
    source_session_id: str | None = Field(default=None, min_length=1, max_length=256)

    @field_validator('capabilities')
    @classmethod
    def validate_capabilities(cls, value: list[str]) -> list[str]:
        return _unique_text(value, 'preflight capabilities')

    @model_validator(mode='after')
    def validate_report(self):
        if self.status == 'passed':
            if not self.workspace_permission:
                raise ValueError('passed preflight requires workspace permission')
            if not any(model.available for model in self.available_models):
                raise ValueError('passed preflight requires an available model')
        if self.status == 'failed' and not self.reason:
            raise ValueError('failed preflight requires a reason')
        reject_credentials(self, 'executor preflight report')
        return self


class ProjectAgentExecutorHealthReport(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    executor_id: str = Field(min_length=1, max_length=128)
    status: ProjectAgentExecutorHealthStatus
    reason: str | None = Field(default=None, min_length=1, max_length=2048)
    checked_at: datetime
    idempotency_key: str = Field(min_length=8, max_length=256)
    source_application: SourceApplication | None = None
    source_session_id: str | None = Field(default=None, min_length=1, max_length=256)

    @model_validator(mode='after')
    def validate_report(self):
        if self.status in {'degraded', 'unhealthy'} and not self.reason:
            raise ValueError('degraded or unhealthy executor requires a reason')
        reject_credentials(self, 'executor health report')
        return self


class ProjectAgentExecutorRecord(StrictModel):
    executor_id: str
    display_name: str
    executor_kind: str
    registration_status: ProjectAgentExecutorRegistrationStatus
    permission_status: ProjectAgentExecutorPermissionStatus
    preflight_status: ProjectAgentExecutorPreflightStatus
    health_status: ProjectAgentExecutorHealthStatus
    health_required: bool = False
    workspace_permission: bool = False
    capabilities: list[str] = Field(default_factory=list)
    available_models: list[ProjectAgentExecutorModelRecord] = Field(
        default_factory=list,
    )
    global_priority: int = Field(ge=1)
    revision: int = Field(default=0, ge=0)
    permission_revision: int = Field(default=0, ge=0)
    preflight_at: datetime | None = None
    health_checked_at: datetime | None = None
    registered_at: datetime
    updated_at: datetime
    test_source: str | None = None
    cleanup_eligible: bool = False


class ProjectAgentExecutorPriorityUpdate(StrictModel):
    executor_id: str = Field(min_length=1, max_length=128)
    global_priority: int = Field(ge=1, le=1_000_000)
    expected_revision: int = Field(ge=0)
    idempotency_key: str = Field(min_length=8, max_length=256)
    reason: str = Field(min_length=1, max_length=2048)

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        reject_credentials(self, 'executor priority update')
        return self


class ProjectAgentExecutorRoutingRuleCreate(StrictModel):
    scope: ProjectAgentExecutorScope
    personal_space_id: str | None = Field(default=None, min_length=1, max_length=128)
    personal_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    task_id: str | None = Field(default=None, min_length=1, max_length=128)
    work_kind: str = Field(min_length=1, max_length=128)
    required_capabilities: list[str] = Field(default_factory=list, max_length=32)
    executor_ids: list[str] = Field(min_length=1, max_length=32)
    model_strategy: ProjectAgentModelStrategy | None = None
    priority: int = Field(default=100, ge=1, le=1_000_000)
    reason: str = Field(min_length=1, max_length=2048)
    idempotency_key: str = Field(min_length=8, max_length=256)

    @field_validator('required_capabilities')
    @classmethod
    def validate_capabilities(cls, value: list[str]) -> list[str]:
        return _unique_text(value, 'routing rule capabilities')

    @field_validator('executor_ids')
    @classmethod
    def validate_executor_ids(cls, value: list[str]) -> list[str]:
        return _unique_ids(value, 'routing rule executor IDs')

    @model_validator(mode='after')
    def validate_scope(self):
        expected = {
            'global': (False, False, False),
            'space': (True, False, False),
            'project': (True, True, False),
            'task': (True, True, True),
        }[self.scope]
        actual = (
            bool(self.personal_space_id),
            bool(self.personal_project_id),
            bool(self.task_id),
        )
        if actual != expected:
            raise ValueError(
                f'{self.scope} routing rule requires exactly the matching scope IDs'
            )
        reject_credentials(self, 'executor routing rule')
        return self


class ProjectAgentExecutorRoutingRuleRecord(
    ProjectAgentExecutorRoutingRuleCreate
):
    rule_id: str
    status: ProjectAgentExecutorRuleStatus = 'active'
    revision: int = Field(default=0, ge=0)
    created_at: datetime
    updated_at: datetime


class ProjectAgentExecutorRoutingRuleUpdate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    rule_id: str = Field(min_length=1, max_length=128)
    expected_revision: int = Field(ge=0)
    status: Literal['active', 'disabled', 'ended']
    reason: str = Field(min_length=1, max_length=2048)
    idempotency_key: str = Field(min_length=8, max_length=256)

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        reject_credentials(self, 'executor routing rule update')
        return self


class ProjectAgentExecutorSelectionRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    task_id: str = Field(min_length=1, max_length=128)
    agent_id: str = Field(min_length=1, max_length=128)
    work_kind: str = Field(min_length=1, max_length=128)
    required_capabilities: list[str] = Field(default_factory=list, max_length=32)
    model_strategy: ProjectAgentModelStrategy = Field(
        default_factory=ProjectAgentModelStrategy
    )
    executor_policy: ProjectAgentExecutorPolicy | None = None
    idempotency_key: str = Field(min_length=8, max_length=256)
    source_application: SourceApplication | None = None
    source_session_id: str | None = Field(default=None, min_length=1, max_length=256)

    @field_validator('required_capabilities')
    @classmethod
    def validate_capabilities(cls, value: list[str]) -> list[str]:
        return _unique_text(value, 'required executor capabilities')

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        reject_credentials(self, 'executor selection request')
        return self


class ProjectAgentExecutorSelection(StrictModel):
    selection_id: str
    task_id: str
    personal_space_id: str
    personal_project_id: str
    agent_id: str
    status: ProjectAgentExecutorSelectionStatus
    outcome: ProjectAgentExecutorSelectionStatus
    selected_executor_id: str | None = None
    # ``executor_id`` is a compatibility alias consumed by the task router.
    executor_id: str | None = None
    selected_provider: str | None = None
    selected_model: str | None = None
    matched_rule_id: str | None = None
    rule_id: str | None = None
    matched_rule_scope: ProjectAgentExecutorScope | None = None
    candidate_executor_ids: list[str] = Field(default_factory=list)
    selection_reason: str
    reason: str
    fallback_outcome: ProjectAgentExecutorFallbackOutcome = 'not_needed'
    fallback_from_executor_id: str | None = None
    fallback_reason: str | None = None
    blocked_reason: str | None = None
    model_strategy: ProjectAgentModelStrategy
    model_strategy_key: str = Field(min_length=64, max_length=64)
    model_strategy_source: Literal[
        'task',
        'assignment',
        'agent',
        'routing_rule',
        'coordinator',
    ] = 'agent'
    executor_policy: ProjectAgentExecutorPolicy = Field(
        default_factory=ProjectAgentExecutorPolicy
    )
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=256)
    payload_fingerprint: str | None = Field(default=None, min_length=16, max_length=128)
    created_at: datetime

    @model_validator(mode='after')
    def validate_strategy_key(self):
        if self.model_strategy_key != project_agent_model_strategy_key(
            self.model_strategy
        ):
            raise ValueError('model strategy key does not match model strategy')
        return self


class ProjectAgentExecutorActualReport(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    task_id: str = Field(min_length=1, max_length=128)
    run_id: str = Field(min_length=1, max_length=128)
    agent_id: str = Field(min_length=1, max_length=128)
    executor_id: str = Field(min_length=1, max_length=128)
    provider: str = Field(min_length=1, max_length=128)
    model: str = Field(min_length=1, max_length=256)
    model_strategy: ProjectAgentModelStrategy = Field(
        default_factory=ProjectAgentModelStrategy
    )
    model_strategy_source: Literal[
        'task',
        'assignment',
        'agent',
        'routing_rule',
        'coordinator',
    ] = 'agent'
    matched_rule_id: str | None = Field(default=None, min_length=1, max_length=128)
    fallback_reason: str | None = Field(default=None, min_length=1, max_length=2048)
    idempotency_key: str = Field(min_length=8, max_length=256)
    occurred_at: datetime
    source_application: SourceApplication | None = None
    source_session_id: str | None = Field(default=None, min_length=1, max_length=256)

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        reject_credentials(self, 'actual executor report')
        return self


class ProjectAgentExecutorOutcomeEvidenceCreate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    work_kind: str = Field(min_length=1, max_length=128)
    agent_id: str = Field(min_length=1, max_length=128)
    executor_id: str = Field(min_length=1, max_length=128)
    task_id: str = Field(min_length=1, max_length=128)
    run_id: str | None = Field(default=None, min_length=1, max_length=128)
    model_strategy: ProjectAgentModelStrategy = Field(
        default_factory=ProjectAgentModelStrategy
    )
    model_strategy_key: str | None = Field(
        default=None,
        min_length=64,
        max_length=64,
    )
    evidence_kind: ProjectAgentExecutorEvidenceKind
    source: ProjectAgentExecutorEvidenceSource
    terminal_outcome: ProjectAgentExecutorTerminalOutcome | None = None
    rating: int | None = Field(default=None, ge=1, le=5)
    reference_ids: list[str] = Field(default_factory=list, max_length=16)
    note: str | None = Field(default=None, min_length=1, max_length=2048)
    idempotency_key: str = Field(min_length=8, max_length=256)
    occurred_at: datetime

    @field_validator('reference_ids')
    @classmethod
    def validate_reference_ids(cls, value: list[str]) -> list[str]:
        return _unique_ids(value, 'evidence reference IDs')

    @model_validator(mode='after')
    def validate_evidence(self):
        expected_strategy_key = project_agent_model_strategy_key(self.model_strategy)
        if self.model_strategy_key and self.model_strategy_key != expected_strategy_key:
            raise ValueError('model strategy key does not match model strategy')
        system_kinds = {'terminal_outcome'}
        test_kinds = {'test_passed', 'test_failed'}
        explicit_kinds = {
            'rework_requested',
            'repeated_negative_feedback',
            'explicit_praise',
            'acceptance_passed',
            'acceptance_failed',
            'explicit_rating',
        }
        if self.evidence_kind in system_kinds and self.source != 'system_terminal':
            raise ValueError('terminal outcome evidence must come from the system')
        if self.evidence_kind in test_kinds and self.source != 'test_fact':
            raise ValueError('test evidence must be recorded as a test fact')
        if self.evidence_kind in explicit_kinds and self.source != 'user_explicit':
            raise ValueError('feedback evidence must be explicitly supplied by a user')
        if self.evidence_kind == 'terminal_outcome' and not self.terminal_outcome:
            raise ValueError('terminal outcome evidence requires a terminal outcome')
        if self.evidence_kind in system_kinds | test_kinds and not self.reference_ids:
            raise ValueError('system or test evidence requires an evidence reference')
        if self.evidence_kind != 'terminal_outcome' and self.terminal_outcome:
            raise ValueError('terminal outcome is only valid for terminal evidence')
        if self.evidence_kind == 'explicit_rating' and self.rating is None:
            raise ValueError('explicit rating evidence requires a rating')
        if self.evidence_kind != 'explicit_rating' and self.rating is not None:
            raise ValueError('rating is only valid for explicit rating evidence')
        if self.evidence_kind in explicit_kinds and not self.reference_ids and not self.note:
            raise ValueError('explicit feedback requires a reference or note')
        reject_credentials(self, 'executor outcome evidence')
        return self


class ProjectAgentExecutorOutcomeEvidenceRecord(
    ProjectAgentExecutorOutcomeEvidenceCreate
):
    # Stored evidence always exposes the canonical bucket key.  The create
    # contract keeps this optional for backwards-compatible callers; the store
    # computes it before returning a durable record.
    model_strategy_key: str = Field(min_length=64, max_length=64)
    evidence_id: str
    ignored: bool = False
    ignored_reason: str | None = None
    created_at: datetime


class ProjectAgentExecutorEvidenceContribution(StrictModel):
    evidence_id: str
    evidence_kind: ProjectAgentExecutorEvidenceKind
    signal: Literal['success', 'failure', 'rework', 'rating', 'neutral']
    value: float
    decay_weight: float = Field(ge=0, le=1)
    occurred_at: datetime
    reference_ids: list[str] = Field(default_factory=list)


class ProjectAgentExecutorOutcomeAggregate(StrictModel):
    personal_space_id: str
    personal_project_id: str
    work_kind: str
    agent_id: str
    executor_id: str
    model_strategy: ProjectAgentModelStrategy
    model_strategy_key: str = Field(min_length=64, max_length=64)
    sample_count: int = Field(ge=0)
    recent_count: int = Field(ge=0)
    success_count: int = Field(ge=0)
    rework_count: int = Field(ge=0)
    failure_count: int = Field(ge=0)
    rating_count: int = Field(ge=0)
    average_rating: float | None = Field(default=None, ge=1, le=5)
    neutral_due_to_insufficient_evidence: bool = False
    ignored: bool = False
    reset_at: datetime | None = None
    as_of: datetime
    decay_half_life_days: float = Field(gt=0)
    weighted_success: float = Field(ge=0)
    weighted_failure: float = Field(ge=0)
    evidence_refs: list[str] = Field(default_factory=list)
    evidence_contributions: list[ProjectAgentExecutorEvidenceContribution] = Field(
        default_factory=list
    )

    @model_validator(mode='after')
    def validate_strategy_key(self):
        if self.model_strategy_key != project_agent_model_strategy_key(
            self.model_strategy
        ):
            raise ValueError('model strategy key does not match model strategy')
        return self


class ProjectAgentExecutorEvidenceIgnore(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    agent_id: str = Field(min_length=1, max_length=128)
    evidence_id: str = Field(min_length=1, max_length=128)
    reason: str = Field(min_length=1, max_length=2048)
    idempotency_key: str = Field(min_length=8, max_length=256)

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        reject_credentials(self, 'executor evidence ignore')
        return self


class ProjectAgentExecutorOutcomeReset(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    work_kind: str = Field(min_length=1, max_length=128)
    agent_id: str = Field(min_length=1, max_length=128)
    executor_id: str = Field(min_length=1, max_length=128)
    model_strategy: ProjectAgentModelStrategy = Field(
        default_factory=ProjectAgentModelStrategy
    )
    model_strategy_key: str | None = Field(
        default=None,
        min_length=64,
        max_length=64,
    )
    reason: str = Field(min_length=1, max_length=2048)
    idempotency_key: str = Field(min_length=8, max_length=256)
    reset_at: datetime

    @model_validator(mode='after')
    def reject_sensitive_values(self):
        expected_strategy_key = project_agent_model_strategy_key(self.model_strategy)
        if self.model_strategy_key and self.model_strategy_key != expected_strategy_key:
            raise ValueError('model strategy key does not match model strategy')
        reject_credentials(self, 'executor evidence reset')
        return self


# Names used by the task store and by older integration code.
ProjectAgentExecutorDecision = ProjectAgentExecutorSelection
ProjectAgentExecutorRouteResult = ProjectAgentExecutorSelection
