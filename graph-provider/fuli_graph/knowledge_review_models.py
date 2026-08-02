from datetime import datetime
from typing import Literal

from pydantic import Field, model_validator

from .models import (
    ConfirmationStatus,
    EpistemicQuadrant,
    KnowledgeFeedbackKind,
    KnowledgeItemKind,
    PersonalProfileAspect,
    PreferenceScope,
    StrictModel,
)

KnowledgeReviewScope = Literal[
    'all',
    'preferences_global',
    'preferences_project',
    'projects_all',
    'project',
]
KnowledgeReviewStatus = Literal['active', 'paused', 'completed']
KnowledgeReviewDisposition = Literal['paused', 'completed']
KnowledgeReviewOutcome = Literal[
    'confirmed', 'updated', 'invalidated', 'deferred', 'delegated_to_ai'
]
KnowledgeReviewReason = Literal[
    'changed_since_last',
    'deferred_from_previous',
    'conflict_or_attention',
    'low_weight',
    'repeated_cross_session',
]


class KnowledgeReviewStart(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    scope: KnowledgeReviewScope
    personal_project_id: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode='after')
    def validate_scope_project(self):
        needs_project = self.scope in {'preferences_project', 'project'}
        if needs_project and not self.personal_project_id:
            raise ValueError(f'{self.scope} requires personal_project_id')
        if not needs_project and self.personal_project_id:
            raise ValueError(f'{self.scope} does not accept personal_project_id')
        return self


class KnowledgeReviewRun(StrictModel):
    review_id: str
    personal_space_id: str
    scope: KnowledgeReviewScope
    personal_project_id: str | None = None
    scope_key: str
    status: KnowledgeReviewStatus
    previous_completed_at: datetime | None = None
    review_cutoff_at: datetime
    started_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None
    resumed: bool = False


class KnowledgeReviewCandidate(StrictModel):
    candidate_key: str
    item_id: str
    item_kind: KnowledgeItemKind
    title: str
    content: str
    # Keep the decision-critical ranking context near the front of the wire
    # payload. Older MCP clients may project a bounded prefix of the Provider
    # response, and the user must still see why a candidate was selected.
    priority: int = Field(ge=1, le=4)
    reasons: list[KnowledgeReviewReason]
    confirmation_status: ConfirmationStatus
    current_quadrant: EpistemicQuadrant
    project_ids: list[str] = Field(default_factory=list)
    profile_aspect: PersonalProfileAspect | None = None
    preference_scope: PreferenceScope | None = None
    preference_project_id: str | None = None
    utility_score: float = Field(ge=0, le=1)
    confidence_score: float = Field(ge=0, le=1)
    qualified_use_count: int = Field(ge=0)
    distinct_task_count: int = Field(ge=0)
    negative_evidence_count: int = Field(ge=0)
    requires_attention: bool
    last_feedback_kind: KnowledgeFeedbackKind | None = None
    distinct_session_count: int = Field(ge=0)
    changed_at: datetime | None = None


class KnowledgeReviewCandidateRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    review_id: str = Field(min_length=1, max_length=256)
    limit: int = Field(default=10, ge=1, le=50)


class KnowledgeReviewCandidatePage(StrictModel):
    review: KnowledgeReviewRun
    candidates: list[KnowledgeReviewCandidate]
    total_candidate_count: int = Field(ge=0)
    remaining_candidate_count: int = Field(ge=0)


class KnowledgeReviewProgress(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    review_id: str = Field(min_length=1, max_length=256)
    candidate_key: str = Field(
        min_length=3,
        max_length=520,
        pattern=r'^(entity|relationship):.+$',
    )
    outcome: KnowledgeReviewOutcome
    note: str | None = Field(default=None, min_length=1, max_length=2000)


class KnowledgeReviewDecision(StrictModel):
    decision_id: str
    review_id: str
    candidate_key: str
    outcome: KnowledgeReviewOutcome
    note: str | None = None
    created_at: datetime
    updated_at: datetime


class KnowledgeReviewFinish(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    review_id: str = Field(min_length=1, max_length=256)
    disposition: KnowledgeReviewDisposition
