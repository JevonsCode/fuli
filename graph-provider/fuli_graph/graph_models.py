from datetime import datetime
from typing import Any

from pydantic import Field

from .models import (
    ConfirmationBasis,
    ConfirmationStatus,
    EpistemicQuadrant,
    EpistemicStatus,
    GraphEvidence,
    HumanChangeStatus,
    KnowledgeAssignmentRecord,
    KnowledgeAuditRecord,
    KnowledgeInheritanceMode,
    KnowledgeItemKind,
    KnowledgeRevisionRecord,
    PersonalProfileAspect,
    PreferenceScope,
    StrictModel,
)
from .project_action_models import (
    KnowledgeConflictRecord,
    KnowledgeProjectReferenceRecord,
)


class GraphNode(StrictModel):
    id: str
    name: str
    type: str
    group_id: str
    summary: str
    origin_quadrant: EpistemicQuadrant = 'known_known'
    current_quadrant: EpistemicQuadrant = 'known_known'
    epistemic_status: EpistemicStatus = 'confirmed'
    epistemic_state_explicit: bool = True
    confirmation_status: ConfirmationStatus = 'pending'
    confirmation_state_explicit: bool = False
    confirmation_basis: ConfirmationBasis | None = None
    reasoning_summary: str | None = None
    profile_aspect: PersonalProfileAspect | None = None
    preference_scope: PreferenceScope | None = None
    preference_project_id: str | None = None
    inheritance_mode: KnowledgeInheritanceMode = 'local_only'
    inherited_project_ids: list[str] = Field(default_factory=list, max_length=32)
    human_edited: bool = False
    human_change_status: HumanChangeStatus = 'none'
    human_change_version: int = Field(default=0, ge=0)
    last_human_changed_at: datetime | None = None
    last_agent_viewed_at: datetime | None = None
    last_agent_reviewed_at: datetime | None = None
    utility_score: float = Field(default=0, ge=0, le=1)
    confidence_score: float = Field(default=0.5, ge=0, le=1)
    qualified_use_count: int = Field(default=0, ge=0)
    distinct_task_count: int = Field(default=0, ge=0)
    last_used_at: datetime | None = None
    usage_generation: int = Field(default=1, ge=1)
    attributes: dict[str, Any] = Field(default_factory=dict)
    evidence: list[GraphEvidence] = Field(default_factory=list)
    created_at: datetime | None = None
    invalid_at: datetime | None = None
    replaced_by_item_id: str | None = None
    replaced_by_item_kind: KnowledgeItemKind | None = None
    revisions: list[KnowledgeRevisionRecord] = Field(default_factory=list)
    assignments: list[KnowledgeAssignmentRecord] = Field(default_factory=list)
    project_references: list[KnowledgeProjectReferenceRecord] = Field(default_factory=list)
    conflicts: list[KnowledgeConflictRecord] = Field(default_factory=list)
    audit_events: list[KnowledgeAuditRecord] = Field(default_factory=list)


class GraphEdge(StrictModel):
    id: str
    source: str
    target: str
    type: str
    fact: str
    origin_quadrant: EpistemicQuadrant = 'known_known'
    current_quadrant: EpistemicQuadrant = 'known_known'
    epistemic_status: EpistemicStatus = 'confirmed'
    epistemic_state_explicit: bool = True
    confirmation_status: ConfirmationStatus = 'pending'
    confirmation_state_explicit: bool = False
    confirmation_basis: ConfirmationBasis | None = None
    reasoning_summary: str | None = None
    profile_aspect: PersonalProfileAspect | None = None
    preference_scope: PreferenceScope | None = None
    preference_project_id: str | None = None
    inheritance_mode: KnowledgeInheritanceMode = 'local_only'
    inherited_project_ids: list[str] = Field(default_factory=list, max_length=32)
    human_edited: bool = False
    human_change_status: HumanChangeStatus = 'none'
    human_change_version: int = Field(default=0, ge=0)
    last_human_changed_at: datetime | None = None
    last_agent_viewed_at: datetime | None = None
    last_agent_reviewed_at: datetime | None = None
    utility_score: float = Field(default=0, ge=0, le=1)
    confidence_score: float = Field(default=0.5, ge=0, le=1)
    qualified_use_count: int = Field(default=0, ge=0)
    distinct_task_count: int = Field(default=0, ge=0)
    last_used_at: datetime | None = None
    usage_generation: int = Field(default=1, ge=1)
    valid_at: datetime | None
    invalid_at: datetime | None
    replaced_by_item_id: str | None = None
    replaced_by_item_kind: KnowledgeItemKind | None = None
    created_at: datetime | None = None
    confidence: float | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)
    episodes: list[str] = Field(default_factory=list)
    evidence: list[GraphEvidence] = Field(default_factory=list)
    revisions: list[KnowledgeRevisionRecord] = Field(default_factory=list)
    assignments: list[KnowledgeAssignmentRecord] = Field(default_factory=list)
    project_references: list[KnowledgeProjectReferenceRecord] = Field(default_factory=list)
    conflicts: list[KnowledgeConflictRecord] = Field(default_factory=list)
    audit_events: list[KnowledgeAuditRecord] = Field(default_factory=list)


class GraphResult(StrictModel):
    space_id: str
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    truncated: bool = False
