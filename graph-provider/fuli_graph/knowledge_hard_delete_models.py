"""Shapes of a person's hard delete of one knowledge item (rec#5 C9)."""
from datetime import datetime
from typing import Literal

from pydantic import Field

from .knowledge_audit_models import KnowledgeItemKind
from .knowledge_item_view_models import KnowledgeVersionStatus
from .model_base import StrictModel

PREVIEW_ID_PATTERN = r'^[0-9a-f]{64}$'


class KnowledgeHardDeleteRef(StrictModel):
    # The item is the route's; the body says which space and kind it is in.
    personal_space_id: str = Field(min_length=1, max_length=128)
    item_kind: KnowledgeItemKind


class KnowledgeHardDeleteConfirm(KnowledgeHardDeleteRef):
    # The preview the person read; a delete of anything else is refused.
    preview_id: str = Field(pattern=PREVIEW_ID_PATTERN)
    # What the person typed: 「删除」, "delete" or the item's title.
    confirmation: str = Field(min_length=1, max_length=512)


class KnowledgeHardDeleteItem(StrictModel):
    """One stored item that goes: the item, another version of it, or (for an
    entity) a relationship that cannot stand without it."""
    item_kind: KnowledgeItemKind
    item_id: str
    role: Literal['item', 'version', 'relationship']
    title: str
    content: str
    status: KnowledgeVersionStatus


class KnowledgeHardDeleteEpisode(StrictModel):
    """A source episode. `other_items` is how many other items still use it;
    an episode is removed only when that is 0."""
    episode_id: str
    source_kind: str | None = None
    source_application: str | None = None
    session_id: str | None = None
    excerpt: str | None = None
    created_at: datetime | None = None
    other_items: int = 0


class KnowledgeHardDeleteDependent(StrictModel):
    """A current conclusion drawn from what goes. It is kept and waits for the
    person's review (not delivered until then)."""
    item_kind: KnowledgeItemKind
    item_id: str
    title: str
    content: str
    direct: bool


class KnowledgeHardDeleteCounts(StrictModel):
    items: int = 0
    versions: int = 0
    relationships: int = 0
    episodes: int = 0
    mentions: int = 0
    revisions: int = 0
    feedback: int = 0
    usage: int = 0
    change_audits: int = 0
    tags: int = 0
    assignments: int = 0
    references: int = 0
    review_decisions: int = 0
    conflicts: int = 0
    promotions: int = 0
    decision_snapshots: int = 0
    kept_episodes: int = 0
    dependents: int = 0


class KnowledgeHardDeletePreview(StrictModel):
    preview_id: str
    item_kind: KnowledgeItemKind
    item_id: str
    title: str
    items: list[KnowledgeHardDeleteItem]
    removed_episodes: list[KnowledgeHardDeleteEpisode]
    kept_episodes: list[KnowledgeHardDeleteEpisode]
    dependents: list[KnowledgeHardDeleteDependent]
    counts: KnowledgeHardDeleteCounts


class KnowledgeHardDeletion(StrictModel):
    """The content-free trace a hard delete leaves: when, by whom, how much."""
    deletion_id: str
    item_kind: KnowledgeItemKind
    deleted_at: datetime
    deleted_by: Literal['user'] = 'user'
    counts: KnowledgeHardDeleteCounts


class KnowledgeHardDeleteRecord(KnowledgeHardDeletion):
    item_id: str
    deleted_item_ids: list[str]
