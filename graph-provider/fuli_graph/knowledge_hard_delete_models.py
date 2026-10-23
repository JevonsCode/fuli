"""Shapes of a person's hard delete of one knowledge item (rec#5 C9)."""
from datetime import datetime
from typing import Literal

from pydantic import Field

from .knowledge_audit_models import KnowledgeItemKind
from .knowledge_item_view_models import KnowledgeVersionStatus
from .model_base import StrictModel

PREVIEW_ID_PATTERN = r'^[0-9a-f]{64}$'
OPERATION_ID_PATTERN = r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
HardDeleteTargetKind = Literal['entity', 'relationship', 'episode', 'session']


class KnowledgeHardDeleteRef(StrictModel):
    # The item is the route's; the body says which space and kind it is in.
    personal_space_id: str = Field(min_length=1, max_length=128)
    item_kind: HardDeleteTargetKind


class KnowledgeHardDeleteConfirm(KnowledgeHardDeleteRef):
    # The preview the person read; a delete of anything else is refused.
    preview_id: str = Field(pattern=PREVIEW_ID_PATTERN)
    # The console's own operation ID; the graph keeps this delete's outcome
    # under it (knowledge_hard_delete_operations.py).
    operation_id: str | None = Field(default=None, pattern=OPERATION_ID_PATTERN)
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


class KnowledgeHardDeleteUser(StrictModel):
    """Another item that still uses a shared source, so the person can open
    it (and delete it too) when the source's words should not stay."""
    item_kind: KnowledgeItemKind
    item_id: str
    title: str


class KnowledgeHardDeleteEpisode(StrictModel):
    """A source episode. `used_by` lists the other items that still use it
    (`other_items` of them); an episode is removed only when there are none."""
    episode_id: str
    source_kind: str | None = None
    source_application: str | None = None
    session_id: str | None = None
    excerpt: str | None = None
    created_at: datetime | None = None
    other_items: int = 0
    used_by: list[KnowledgeHardDeleteUser] = Field(default_factory=list)


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


class KnowledgeHardDeletePublication(StrictModel):
    draft_id: str
    project_id: str
    project_name: str | None = None
    provider_url: str
    proposal_id: str
    source_episode_ids: list[str]
    status: Literal['submitted'] = 'submitted'
    local_delete_retracts: Literal[False] = False
    withdrawal_status: Literal['unavailable'] = 'unavailable'
    withdrawal_url: None = None


class KnowledgeHardDeleteDrafts(StrictModel):
    pending: int = 0
    submitted: int = 0


class KnowledgeHardDeletePreview(StrictModel):
    publications: list[KnowledgeHardDeletePublication] = Field(default_factory=list)
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
    item_kind: HardDeleteTargetKind
    deleted_at: datetime
    deleted_by: Literal['user'] = 'user'
    counts: KnowledgeHardDeleteCounts


class KnowledgeHardDeleteRecord(KnowledgeHardDeletion):
    item_id: str
    deleted_item_ids: list[str]


class KnowledgeHardDeleteSpace(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)


class KnowledgeHardDeleteOperation(StrictModel):
    """A console's delete operation as the graph knows it: committed (with its
    deletion), refused or aborted (with the code), or unknown (not arrived,
    or still running)."""
    operation_id: str
    state: Literal['committed', 'refused', 'aborted', 'unknown']
    code: str | None = None
    deletion: KnowledgeHardDeleteRecord | None = None


class KnowledgeHardDeleteStatus(StrictModel):
    """Where one item stands for a console that does not know whether its
    delete committed: deleted (with the trace), present, or missing."""
    state: Literal['deleted', 'present', 'missing']
    deletion: KnowledgeHardDeleteRecord | None = None
