from datetime import datetime
from typing import Any, Literal

from pydantic import Field, model_validator

from .model_base import StrictModel


KnowledgeItemKind = Literal['entity', 'relationship']
KnowledgeOperationActor = Literal['human', 'agent']
KnowledgeChangeActor = Literal['user', 'agent']
HumanChangeStatus = Literal['none', 'unseen', 'viewed', 'reviewed']
KnowledgeAuditAction = Literal[
    'human_change',
    'agent_view',
    'agent_review',
    'knowledge_used',
    'knowledge_feedback',
]
KnowledgeUseKind = Literal['cited', 'applied']
KnowledgeFeedbackKind = Literal[
    'rejected',
    'validation_failed',
    'contradicted',
    'outdated',
]
KnowledgeRevisionAction = Literal[
    'confirm',
    'update',
    'invalidate',
    'link_replacement',
    'restore',
    # rec#5 C7/C8: a new version replaced this one; a person marked it
    # outdated; knowledge it was concluded from went out of date; and a later
    # version re-asserted it after it went out of date.
    'supersede',
    'mark_outdated',
    'basis_outdated',
    'reassert',
    # D-20.7: a basis changed its meaning (the conclusion waits for a person),
    # only its wording (a hint), or a person said the conclusion still holds.
    'basis_changed',
    'basis_reworded',
    'basis_review_cleared',
    'reaffirm',
    'mark_meaning_changed',
    'scope_change',
    'batch_confirm',
    'promote_common',
    'replace_common_duplicate',
]
PreferenceScope = Literal['global', 'project']


class KnowledgeAssignmentChange(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    item_kind: KnowledgeItemKind
    target_project_id: str = Field(min_length=1, max_length=128)
    reason: str = Field(min_length=1, max_length=2000)
    operation_actor: KnowledgeOperationActor = 'agent'


class PreferenceScopeChange(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    item_kind: KnowledgeItemKind
    scope: PreferenceScope
    project_id: str | None = Field(default=None, min_length=1, max_length=128)
    reason: str = Field(min_length=1, max_length=2000)
    operation_actor: KnowledgeOperationActor = 'agent'

    @model_validator(mode='after')
    def validate_project_scope(self):
        if self.scope == 'project' and not self.project_id:
            raise ValueError('project_id is required for project preference scope')
        if self.scope == 'global' and self.project_id:
            raise ValueError('project_id is only valid for project preference scope')
        return self


class KnowledgeRevisionRecord(StrictModel):
    id: str
    item_id: str
    item_kind: KnowledgeItemKind
    action: KnowledgeRevisionAction
    reason: str
    previous: dict[str, Any] = Field(default_factory=dict)
    current: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    # Who made the change, where the revision recorded it (rec#5 C7): the
    # person in the console or an Agent. Older revisions did not say.
    changed_by: KnowledgeChangeActor | None = None
    # The new version an edit wrote; the edited item is history from now on.
    version_item_id: str | None = None
    # Conclusions drawn from knowledge marked outdated that stopped being
    # current with it (rec#5 C8-4).
    dependents_outdated: int = Field(default=0, ge=0)
    # pending_person: an Agent reported something a person confirmed as
    # outdated; only the feedback was recorded and the person decides (D-20.10).
    outcome: Literal['applied', 'pending_person'] = 'applied'
    # Conclusions that now wait for a person because their basis changed
    # meaning, or were delivered again because it did not (D-20.7).
    dependents_changed: int = Field(default=0, ge=0)


class KnowledgeAuditRecord(StrictModel):
    id: str
    item_id: str
    item_kind: KnowledgeItemKind
    action: KnowledgeAuditAction
    human_change_version: int = Field(default=0, ge=0)
    reason: str
    tool_name: str | None = None
    task_id: str | None = None
    session_id: str | None = None
    use_kind: KnowledgeUseKind | None = None
    feedback_kind: KnowledgeFeedbackKind | None = None
    reported_by_kind: Literal[
        'user',
        'agent',
        'authoritative_source',
    ] | None = None
    evidence_summary: str | None = None
    source_uri: str | None = None
    usage_generation: int | None = Field(default=None, ge=1)
    conflict_check: Literal['no_conflict', 'conflict'] | None = None
    classification_check: Literal['reasonable', 'needs_change'] | None = None
    outcome: Literal[
        'pending_review',
        'requires_attention',
        'reviewed',
        'agent_confirmed',
    ] | None = None
    created_at: datetime


class KnowledgeAgentViewItem(StrictModel):
    item_id: str = Field(min_length=1, max_length=256)
    item_kind: KnowledgeItemKind


class KnowledgeAgentViewCreate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    tool_name: str = Field(min_length=1, max_length=128)
    items: list[KnowledgeAgentViewItem] = Field(max_length=200)


class KnowledgeAgentViewResult(StrictModel):
    recorded_count: int = Field(ge=0, le=200)
    item_keys: list[str] = Field(max_length=200)


class KnowledgeAgentReviewCreate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    item_kind: KnowledgeItemKind
    human_change_version: int = Field(ge=1)
    conflict_check: Literal['no_conflict', 'conflict']
    classification_check: Literal['reasonable', 'needs_change']
    note: str = Field(min_length=1, max_length=2000)


class KnowledgeHumanChangeSearchRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    query: str = Field(default='', max_length=2048)
    status: Literal[
        'all',
        'human_changed',
        'unseen',
        'viewed',
        'reviewed',
    ] = 'all'
    limit: int = Field(default=50, ge=1, le=200)


class KnowledgeHumanChangeItem(StrictModel):
    item_id: str
    item_kind: KnowledgeItemKind
    title: str
    body: str
    type: str
    human_change_status: HumanChangeStatus
    human_change_version: int = Field(ge=1)
    last_human_changed_at: datetime
    last_agent_viewed_at: datetime | None = None
    last_agent_reviewed_at: datetime | None = None
    audit_events: list[KnowledgeAuditRecord] = Field(default_factory=list)


class KnowledgeHumanChangeSearchResult(StrictModel):
    items: list[KnowledgeHumanChangeItem] = Field(default_factory=list)


class KnowledgeAssignmentRecord(StrictModel):
    id: str
    item_id: str
    item_kind: KnowledgeItemKind
    project_id: str
    previous_project_id: str | None = None
    reason: str
    created_at: datetime
    updated_at: datetime
