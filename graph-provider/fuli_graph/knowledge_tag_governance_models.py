"""Contracts of the person's tag governance and the console's vocabulary reads
(rec#5 G4-5, rec#11 D-07 part 2).

A governance change is previewed by anyone who can see the tag, an Agent
included, and applied only on the human-review channel, naming the digest of
the preview the person saw. Previews are plain summaries: an Agent's preview
never counts links (they may sit on other projects' knowledge) and never names
a tag its scope cannot see.
"""
from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator, model_validator

from .knowledge_audit_models import KnowledgeItemKind
from .knowledge_tag_models import (
    TAG_NAME_MAX,
    KnowledgeTagReference,
    KnowledgeTagScope,
    KnowledgeTagSource,
    StoredTagNamespace,
    TagStatus,
    tag_text,
)
from .model_base import StrictModel
from .model_validation import reject_credentials

GovernanceChange = Literal['approve', 'merge', 'split', 'retire', 'remove_alias', 'relate', 'unrelate', 'undo']
TagRelationKind = Literal['parent', 'related']
MAX_SPLIT_LINKS = 500
MAX_SPLIT_ALIASES = 100
_REQUIRED = {'merge': ('into_tag_id',), 'split': ('split',), 'remove_alias': ('alias',),
             'relate': ('target_tag_id', 'relation'), 'unrelate': ('target_tag_id', 'relation')}


class KnowledgeTagItemRef(StrictModel):
    item_kind: KnowledgeItemKind
    item_id: str = Field(min_length=1, max_length=256)


class KnowledgeTagSplit(StrictModel):
    """The new tag's name and what moves to it from the split tag, or the tag a
    mistaken merge took in: then every item it carried moves back, read from
    that merge's own record, at most MAX_SPLIT_LINKS per split."""
    name: str | None = Field(default=None, min_length=1, max_length=TAG_NAME_MAX * 2)
    restore_tag_id: str | None = Field(default=None, min_length=1, max_length=128)
    description: str | None = Field(default=None, min_length=1, max_length=500)
    aliases: list[str] = Field(default_factory=list, max_length=MAX_SPLIT_ALIASES)
    links: list[KnowledgeTagItemRef] = Field(default_factory=list, max_length=MAX_SPLIT_LINKS)

    @field_validator('name')
    @classmethod
    def visible_name(cls, value: str | None) -> str | None:
        return None if value is None else tag_text(value, 'name')

    @model_validator(mode='after')
    def one_target(self):
        if (self.name is None) == (self.restore_tag_id is None):
            raise ValueError('a split names a new tag or the merged tag to restore, not both')
        if self.restore_tag_id and self.links:
            raise ValueError('restoring a merged tag moves the links its merge recorded')
        return self

    @field_validator('aliases')
    @classmethod
    def visible_aliases(cls, values: list[str]) -> list[str]:
        return [tag_text(value, 'alias') for value in values]


class KnowledgeTagGovernanceRequest(KnowledgeTagScope):
    change: GovernanceChange
    tag_id: str = Field(min_length=1, max_length=128)
    into_tag_id: str | None = Field(default=None, min_length=1, max_length=128)
    target_tag_id: str | None = Field(default=None, min_length=1, max_length=128)
    relation: TagRelationKind | None = None
    alias: str | None = Field(default=None, min_length=1, max_length=TAG_NAME_MAX * 2)
    # Undo: the operation to reverse; without one, the tag's latest undoable change.
    operation_id: str | None = Field(default=None, min_length=1, max_length=128)
    split: KnowledgeTagSplit | None = None
    # The owner's console governs every project's vocabulary; Agents never ask.
    include_all_projects: bool = False

    @model_validator(mode='after')
    def change_fields(self):
        missing = [field for field in _REQUIRED.get(self.change, ()) if getattr(self, field) is None]
        if missing:
            raise ValueError(f'{self.change} needs {", ".join(missing)}')
        return self


class KnowledgeTagGovernanceApply(KnowledgeTagGovernanceRequest):
    reason: str = Field(min_length=1, max_length=500)
    # The digest of the preview the person confirmed; anything changed since refuses.
    preview_digest: str = Field(pattern=r'^[0-9a-f]{64}$')

    @model_validator(mode='after')
    def no_credentials(self):
        reject_credentials(self, 'Knowledge tag governance')
        return self


class KnowledgeTagRelationDrop(StrictModel):
    """A relation a merge cannot carry over: it would make a parent cycle,
    point a tag at itself, or give a personal tag a project parent."""
    tag: KnowledgeTagReference
    relation: TagRelationKind
    target: KnowledgeTagReference
    # gone: a tag that came back kept a relation whose other end is gone or no
    # longer lists it; limit: the other side's list is full.
    reason: Literal['cycle', 'self', 'scope', 'limit', 'gone']


class KnowledgeTagUndoPreview(StrictModel):
    operation_id: str
    action: str
    created_at: datetime
    restores: list[KnowledgeTagReference]


class KnowledgeTagBlocked(StrictModel):
    code: str
    message: str


class KnowledgeTagGovernancePreview(StrictModel):
    change: GovernanceChange
    tag: KnowledgeTagReference
    # Merge target, relation target, or the tag a split creates or revives.
    other: KnowledgeTagReference | None = None
    status_after: TagStatus | None = None
    new_tag_name: str | None = None
    # A split names a tag that was merged into this one or retired: it comes back.
    revives: bool = False
    links_moved: int | None = None
    links_already_on_target: int | None = None
    # A restoring split moves a batch at a time: what is left for the next one.
    links_remaining: int | None = None
    # Aliases a split moves or a removal takes away.
    aliases: list[str] = Field(default_factory=list)
    # A tag that comes back gives up aliases another visible tag holds now.
    aliases_dropped: list[str] = Field(default_factory=list)
    relations_moved: int = 0
    relations_dropped: list[KnowledgeTagRelationDrop] = Field(default_factory=list)
    undo: KnowledgeTagUndoPreview | None = None
    blocked: KnowledgeTagBlocked | None = None
    digest: str


class KnowledgeTagGovernanceResult(StrictModel):
    change: GovernanceChange
    operation_id: str
    preview: KnowledgeTagGovernancePreview
    tags: list[KnowledgeTagReference]


class KnowledgeTagVocabularyQuery(KnowledgeTagScope):
    query: str | None = Field(default=None, min_length=1, max_length=TAG_NAME_MAX * 2)
    namespace: StoredTagNamespace | None = None
    # review: provisional tags and tags with an alias still to accept.
    status: Literal['provisional', 'active', 'merged', 'retired', 'review'] | None = None
    include_all_projects: bool = False
    limit: int = Field(default=100, ge=1, le=200)
    offset: int = Field(default=0, ge=0)


class KnowledgeTagEntry(StrictModel):
    id: str
    name: str
    namespace: StoredTagNamespace
    project_id: str | None
    status: TagStatus
    description: str | None
    aliases: list[str]
    provisional_aliases: list[str]
    proposed_aliases: list[str]
    # Attached links; counted only for the owner's all-project view.
    linked_items: int | None
    parents: list[KnowledgeTagReference]
    related: list[KnowledgeTagReference]
    merged_into: KnowledgeTagReference | None
    needs_review: bool
    source: KnowledgeTagSource
    version: int
    created_at: datetime
    updated_at: datetime


class KnowledgeTagVocabulary(StrictModel):
    tags: list[KnowledgeTagEntry]
    total: int
    next_offset: int | None
    review_count: int


class KnowledgeTagDetailQuery(KnowledgeTagScope):
    tag_id: str = Field(min_length=1, max_length=128)
    include_all_projects: bool = False


class KnowledgeTagLinkedItem(StrictModel):
    item_kind: KnowledgeItemKind
    item_id: str
    title: str | None
    attached_at: datetime | None
    # Set when a merge or split moved the link here from another tag.
    moved_from: KnowledgeTagReference | None


class KnowledgeTagHistoryEntry(StrictModel):
    action: str
    actor_kind: Literal['agent', 'human']
    reason: str | None
    created_at: datetime
    version: int
    operation_id: str | None
    alias: str | None
    relation: TagRelationKind | None
    other: KnowledgeTagReference | None
    undone: bool
    undoable: bool


class KnowledgeTagDetail(StrictModel):
    tag: KnowledgeTagEntry
    children: list[KnowledgeTagReference]
    merged_from: list[KnowledgeTagReference]
    # None outside the owner's all-project view: links may be other projects' knowledge.
    links: list[KnowledgeTagLinkedItem] | None
    links_truncated: bool
    history: list[KnowledgeTagHistoryEntry]
