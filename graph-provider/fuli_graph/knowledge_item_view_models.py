"""One knowledge item as its owner sees and corrects it (rec#20).

Every value is read back from the stored item: nothing a model claimed, and no
weight where the item has none. The view grants nothing; each read and write
is authorized on its own.
"""
from datetime import datetime
from typing import Literal

from pydantic import Field, model_validator

from .knowledge_audit_models import KnowledgeItemKind, KnowledgeRevisionRecord
from .knowledge_tag_models import KnowledgeTagReference
from .model_base import StrictModel
from .models import ConfirmationStatus, ContentSource

# What kind of content an item holds, for its label. Derived from the item's
# stored profile aspect or type; not a separate Rule model.
KnowledgeItemCategory = Literal['taste', 'judgment', 'personality', 'rule', 'experience', 'fact', 'knowledge']
KnowledgeScopeKind = Literal['global', 'projects', 'agent', 'temporary', 'unknown']
KnowledgeItemChange = Literal['created', 'updated']
MAX_SCOPE_PROJECTS = 16
MAX_RECEIPT_EPISODES = 3


class KnowledgeItemRef(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    item_kind: KnowledgeItemKind
    item_id: str = Field(min_length=1, max_length=256)


class KnowledgeScopeProject(StrictModel):
    id: str
    name: str | None = None
    temporary: bool = False


class KnowledgeItemScope(StrictModel):
    kind: KnowledgeScopeKind
    projects: list[KnowledgeScopeProject] = Field(default_factory=list)
    agent_id: str | None = None
    agent_name: str | None = None
    # 'undetermined': saved where nobody chose its scope yet. A separate state
    # from the content's confirmation.
    status: Literal['set', 'undetermined'] = 'set'


class KnowledgeWeightBasis(StrictModel):
    confirmation_status: ConfirmationStatus
    confirmed_by_person: bool = False
    qualified_use_count: int = 0
    distinct_task_count: int = 0
    source_count: int = 0
    negative_evidence_count: int = 0


class KnowledgeItemWeight(StrictModel):
    """The display weight and what it was computed from; never an authorization."""
    percent: int = Field(ge=10, le=100)
    basis: KnowledgeWeightBasis


class KnowledgeItemSummary(StrictModel):
    item_kind: KnowledgeItemKind
    item_id: str
    version: int
    title: str
    content: str
    type: str
    profile_aspect: str | None = None
    category: KnowledgeItemCategory
    scope: KnowledgeItemScope
    weight: KnowledgeItemWeight | None = None
    tags: list[KnowledgeTagReference] = Field(default_factory=list)
    confirmation_status: ConfirmationStatus
    content_source: ContentSource | None = None
    invalid_at: datetime | None = None
    created_at: datetime | None = None


class KnowledgeEvidenceSource(StrictModel):
    episode_id: str
    source_kind: str | None = None
    source_application: str | None = None
    session_id: str | None = None
    source_turn_id: str | None = None
    excerpt: str | None = None
    personal_project_id: str | None = None
    created_at: datetime | None = None


class KnowledgeItemView(KnowledgeItemSummary):
    evidence: list[KnowledgeEvidenceSource] = Field(default_factory=list)
    evidence_count: int = 0
    revisions: list[KnowledgeRevisionRecord] = Field(default_factory=list)


class KnowledgeTurnReceiptRead(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    episode_ids: list[str] = Field(min_length=1, max_length=MAX_RECEIPT_EPISODES)


class KnowledgeReceiptEntry(KnowledgeItemSummary):
    change: KnowledgeItemChange


class KnowledgeTurnReceipt(StrictModel):
    """What one turn's capture episodes actually changed: new or replaced items.
    Items the episodes only mentioned again changed nothing and are counted."""
    entries: list[KnowledgeReceiptEntry] = Field(default_factory=list)
    unchanged_count: int = 0


class KnowledgeScopeChange(StrictModel):
    # The item is the route's; the body says which space and kind it is in.
    personal_space_id: str = Field(min_length=1, max_length=128)
    item_kind: KnowledgeItemKind
    expected_version: int = Field(ge=0)
    reason: str = Field(min_length=1, max_length=2000)
    scope: Literal['global', 'projects', 'agent']
    project_ids: list[str] = Field(default_factory=list, max_length=MAX_SCOPE_PROJECTS)
    agent_id: str | None = Field(default=None, min_length=1, max_length=128)
    # A quick edit is a person's console action, never an Agent's.
    operation_actor: Literal['human'] = 'human'

    @model_validator(mode='after')
    def validate_scope(self):
        if len(set(self.project_ids)) != len(self.project_ids) or any(
                not project or len(project) > 128 for project in self.project_ids):
            raise ValueError('project_ids must be unique project IDs')
        if self.scope == 'global' and (self.project_ids or self.agent_id):
            raise ValueError('global scope names no project or Agent')
        if self.scope == 'projects' and (not self.project_ids or self.agent_id):
            raise ValueError('projects scope names one or more projects and no Agent')
        if self.scope == 'agent' and (len(self.project_ids) != 1 or not self.agent_id):
            raise ValueError('agent scope names exactly one project and its Agent')
        return self
