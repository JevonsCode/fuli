from datetime import datetime
from typing import Literal

from pydantic import Field

from .models import StrictModel

WorkflowCandidateStatus = Literal['pending', 'approved', 'rejected']
WorkflowConfirmationAuthority = Literal[
    'none',
    'agent_proposed',
    'import_proposed',
    'authoritative_source',
    'user',
]
WorkflowRecommendationAction = Literal[
    'none',
    'ask_user',
    'authorized_rule_available',
]


class WorkflowCandidateSearch(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    after_step_key: str | None = Field(default=None, min_length=1, max_length=256)
    limit: int = Field(default=20, ge=1, le=100)


class WorkflowRecommendationWeights(StrictModel):
    occurrences: float = Field(ge=0, le=1)
    distinct_sessions: float = Field(ge=0, le=1)
    recency: float = Field(ge=0, le=1)
    confirmation_authority: float = Field(ge=0, le=1)


class WorkflowRecommendationPolicy(StrictModel):
    minimum_occurrences: int = Field(ge=1)
    minimum_distinct_sessions: int = Field(ge=1)
    recommendation_threshold: float = Field(ge=0, le=1)
    weights: WorkflowRecommendationWeights
    decline_penalty: float = Field(ge=0, le=1)
    negative_evidence_penalty: float = Field(ge=0, le=1)


class WorkflowRecency(StrictModel):
    first_observed_at: datetime
    last_observed_at: datetime
    age_days: float = Field(ge=0)
    score: float = Field(ge=0, le=1)


class WorkflowRecommendation(StrictModel):
    recommended: bool
    score: float = Field(ge=0, le=1)
    threshold: float = Field(ge=0, le=1)
    action: WorkflowRecommendationAction


class WorkflowAuthorization(StrictModel):
    authorization_id: str
    candidate_id: str
    candidate_version: int = Field(ge=1)
    rule_id: str
    rule_fingerprint: str
    scope: Literal['durable']
    active: bool
    authority: Literal['user', 'authoritative_source']
    created_at: datetime
    high_risk_per_call_approval_required: bool
    high_risk_action_categories: list[
        Literal['send', 'delete', 'publish', 'payment', 'external_write']
    ]


class WorkflowCandidate(StrictModel):
    candidate_id: str
    candidate_version: int = Field(default=1, ge=1)
    evidence_revision: int = Field(default=1, ge=1)
    decision_revision: int = Field(default=0, ge=0)
    rule_fingerprint: str
    workflow_key: str
    condition: dict[str, object] = Field(default_factory=dict)
    personal_space_id: str
    personal_project_id: str | None = None
    source_step_id: str
    source_step_key: str
    source_step_name: str
    target_step_id: str
    target_step_key: str
    target_step_name: str
    status: WorkflowCandidateStatus
    occurrence_count: int = Field(ge=3)
    distinct_session_count: int = Field(ge=0)
    recency: WorkflowRecency
    confirmation_authority: WorkflowConfirmationAuthority
    negative_evidence_count: int = Field(ge=0)
    decline_count: int = Field(ge=0)
    reviewed_at: datetime | None = None
    review_reason: str | None = None
    recommendation: WorkflowRecommendation
    execution_authorized: bool
    authorization: WorkflowAuthorization | None = None


class WorkflowCandidatePage(StrictModel):
    policy: WorkflowRecommendationPolicy
    candidates: list[WorkflowCandidate]
