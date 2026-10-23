"""Human-selected source range and the two layers of its deletion preview."""
from typing import Annotated, Literal

from pydantic import Field, model_validator

from .knowledge_hard_delete_models import (
    OPERATION_ID_PATTERN, PREVIEW_ID_PATTERN, KnowledgeHardDeleteCounts,
    KnowledgeHardDeleteDrafts, KnowledgeHardDeleteEpisode, KnowledgeHardDeleteItem, KnowledgeHardDeletePublication,
)
from .model_base import StrictModel

SourceSelectionKey = Annotated[str, Field(min_length=1, max_length=512, pattern=r'^(entity|relationship):[^\s:]+$')]


class SourceDeleteRef(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    # The route ID is Episodic.uuid or the opaque source_session_id. An episode
    # gets its source identity from storage, never from a caller's claim.
    item_kind: Literal['episode', 'session']
    source_application: str | None = Field(default=None, min_length=1, max_length=128)
    fuli_session_id: str | None = Field(default=None, min_length=1, max_length=512)
    include: list[SourceSelectionKey] = Field(default_factory=list, max_length=10000)
    exclude: list[SourceSelectionKey] = Field(default_factory=list, max_length=10000)

    @model_validator(mode='after')
    def exact_range(self):
        has_session = self.source_application is not None and self.fuli_session_id is not None
        if self.item_kind == 'session' and not has_session:
            raise ValueError('a session requires both source application and session ID')
        if self.item_kind == 'episode' and (self.source_application is not None or self.fuli_session_id is not None):
            raise ValueError('an episode takes its source identity from storage')
        if set(self.include) & set(self.exclude):
            raise ValueError('a selection cannot include and exclude the same item')
        if len(set(self.include)) != len(self.include) or len(set(self.exclude)) != len(self.exclude):
            raise ValueError('selection keys must be unique')
        return self


class SourceDeleteConfirm(SourceDeleteRef):
    preview_id: str = Field(pattern=PREVIEW_ID_PATTERN)
    operation_id: str = Field(pattern=OPERATION_ID_PATTERN)
    confirmation: str = Field(min_length=1, max_length=512)


class SourceDeleteItem(StrictModel):
    key: str
    selected: bool
    reason: Literal['sole_source', 'attached_relationship', 'multiple_sources', 'derived']
    basis_changed: bool
    source_count: int
    retained_source_count: int
    versions: list[KnowledgeHardDeleteItem]


class SourceDeleteCounts(KnowledgeHardDeleteCounts):
    source_turns: int = 0
    conversation_events: int = 0
    conversation_summaries: int = 0


class SourceDeletePreview(StrictModel):
    preview_id: str
    item_kind: Literal['episode', 'session']
    item_id: str
    title: str
    source_application: str | None
    fuli_session_id: str | None
    include: list[str]
    exclude: list[str]
    default_items: list[SourceDeleteItem]
    affected_items: list[SourceDeleteItem]
    removed_episodes: list[KnowledgeHardDeleteEpisode]
    counts: SourceDeleteCounts
    publications: list[KnowledgeHardDeletePublication]
    drafts: KnowledgeHardDeleteDrafts
