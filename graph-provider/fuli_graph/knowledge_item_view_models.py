"""One knowledge item as its owner sees and corrects it (rec#20).

Every value is read back from the stored item: nothing a model claimed, and no
weight where the item has none. The view grants nothing; each read and write
is authorized on its own.
"""
from datetime import datetime
from typing import Literal

from pydantic import Field, model_serializer, model_validator

from .knowledge_audit_models import KnowledgeChangeActor, KnowledgeItemKind, KnowledgeRevisionRecord
from .knowledge_tag_models import KnowledgeTagReference
from .model_base import StrictModel
from .models import AgentReaderRef, ConfirmationStatus, ContentSource, SearchRequest

# What kind of content an item holds, for its label. Derived from the item's
# stored profile aspect or type; not a separate Rule model.
KnowledgeItemCategory = Literal['taste', 'judgment', 'personality', 'rule', 'experience', 'fact', 'knowledge']
KnowledgeScopeKind = Literal['global', 'projects', 'agent', 'temporary', 'unknown']
KnowledgeItemChange = Literal['created', 'updated']
# Where one version stands (rec#5 C7/C8): the one current answers use, or why
# it is history: a newer version replaced it, a person marked it outdated,
# knowledge it was concluded from went out of date, or it was deactivated.
KnowledgeVersionStatus = Literal['current', 'superseded', 'outdated', 'basis_outdated', 'inactive']
# A basis may also be gone: a person hard-deleted it (rec#5 C9).
KnowledgeBasisStatus = KnowledgeVersionStatus | Literal['deleted']
MAX_SCOPE_PROJECTS = 16
MAX_RECEIPT_EPISODES = 3
MAX_VISIBLE_ITEMS = 100


class KnowledgeItemRef(AgentReaderRef):
    personal_space_id: str = Field(min_length=1, max_length=128)
    item_kind: KnowledgeItemKind
    item_id: str = Field(min_length=1, max_length=256)
    # Optional console-only search context: recompute an explanation on demand.
    query_tags: SearchRequest | None = None

    @model_validator(mode='after')
    def validate_query_tags_space(self):
        if self.query_tags is not None and self.query_tags.space_ids != [self.personal_space_id]:
            raise ValueError('query_tags must search exactly the item personal space')
        return self


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
    requires_attention: bool = False


class KnowledgeItemWeight(StrictModel):
    """The weight search ranks by and what it was computed from; never an authorization."""
    percent: int = Field(ge=0, le=100)
    basis: KnowledgeWeightBasis


class KnowledgeItemTag(KnowledgeTagReference):
    # The project whose vocabulary holds a project tag: a change to that tag is
    # made from that project, the only scope that can see it.
    project_id: str | None = None


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
    tags: list[KnowledgeItemTag] = Field(default_factory=list)
    confirmation_status: ConfirmationStatus
    content_source: ContentSource | None = None
    invalid_at: datetime | None = None
    created_at: datetime | None = None
    status: KnowledgeVersionStatus = 'current'


class KnowledgeVersion(StrictModel):
    """One version of an item: its own words, source label and confirmation,
    who wrote it and why, and since when it is no longer valid."""
    item_kind: KnowledgeItemKind
    item_id: str
    content: str
    status: KnowledgeVersionStatus
    confirmation_status: ConfirmationStatus
    content_source: ContentSource | None = None
    changed_by: KnowledgeChangeActor | None = None
    reason: str | None = None
    created_at: datetime | None = None
    invalid_at: datetime | None = None
    # Bases that were out of date when this version re-asserted its words and
    # that it no longer rests on (依据已过时，重新确认时解除).
    released_bases: list[str] = Field(default_factory=list)


class KnowledgeBasis(StrictModel):
    """Knowledge this item was concluded from, and where it stands now."""
    item_kind: KnowledgeItemKind
    item_id: str
    content: str
    status: KnowledgeBasisStatus


class KnowledgeEvidenceSource(StrictModel):
    """Where one source of an item came from: the host session, its Agent
    conversation (absent before rec#5 C6 or without a journal), client, turn,
    project and time. The console opens the session's record list from it."""
    episode_id: str
    source_kind: str | None = None
    source_application: str | None = None
    session_id: str | None = None
    conversation_id: str | None = None
    source_turn_id: str | None = None
    excerpt: str | None = None
    personal_project_id: str | None = None
    created_at: datetime | None = None


class KnowledgeUnavailableSource(StrictModel):
    """Content-free evidence whose deletion still awaits the person's review."""
    episode_id: str
    deletion_id: str
    status: Literal['unavailable'] = 'unavailable'


class KnowledgeItemView(KnowledgeItemSummary):
    tag_ranking: dict | None = None

    @model_serializer(mode='wrap')
    def serialize_optional_tag_ranking(self, handler):
        result = handler(self)
        if self.tag_ranking is None:
            result.pop('tag_ranking', None)
        return result

    evidence: list[KnowledgeEvidenceSource] = Field(default_factory=list)
    evidence_count: int = 0
    unavailable_sources: list[KnowledgeUnavailableSource] = Field(default_factory=list)
    revisions: list[KnowledgeRevisionRecord] = Field(default_factory=list)
    # Every version, newest first, and the one current answers use now (None
    # once the whole item is history).
    versions: list[KnowledgeVersion] = Field(default_factory=list)
    current_item_id: str | None = None
    bases: list[KnowledgeBasis] = Field(default_factory=list)
    # D-20.7: 'changed' while a basis changed its meaning and the conclusion
    # waits for a person (not delivered); 'reworded' when only the wording
    # moved (a hint, still delivered). And how many current conclusions rest
    # on this item's chain, so an edit form can ask what the edit means.
    basis_review: Literal['changed', 'reworded'] | None = None
    dependent_count: int = 0


class KnowledgeTurnReceiptRead(AgentReaderRef):
    personal_space_id: str = Field(min_length=1, max_length=128)
    episode_ids: list[str] = Field(min_length=1, max_length=MAX_RECEIPT_EPISODES)


class KnowledgeItemKey(StrictModel):
    item_kind: KnowledgeItemKind
    item_id: str = Field(min_length=1, max_length=256)


class KnowledgeVisibleItemsRead(AgentReaderRef):
    """Which of these items exist and this reader may see now (rec#50): a
    local record that names one shows it only while it does."""
    personal_space_id: str = Field(min_length=1, max_length=128)
    items: list[KnowledgeItemKey] = Field(min_length=1, max_length=MAX_VISIBLE_ITEMS)


class KnowledgeVisibleItems(StrictModel):
    # In the order asked, without the ones this reader may not see or that are gone.
    items: list[KnowledgeItemKey] = Field(default_factory=list)


class KnowledgeReceiptEntry(KnowledgeItemSummary):
    change: KnowledgeItemChange


class KnowledgeTurnReceipt(StrictModel):
    """What one turn's capture episodes actually changed: new or replaced items.
    Items the episodes only mentioned again changed nothing and are counted."""
    entries: list[KnowledgeReceiptEntry] = Field(default_factory=list)
    unchanged_count: int = 0
    # The hard deletes that removed something these episodes recorded (C9):
    # their opaque IDs, so a reader of several batches counts each once.
    deleted_count: int = 0
    deletion_ids: list[str] = Field(default_factory=list)


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
