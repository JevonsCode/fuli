"""A session's batch migration into a formal project (rec#20 part 2).

What one host session held in its temporary project because nobody chose a
scope, read for the person, and the items the person chose to move.
"""
from typing import Literal

from pydantic import Field, model_validator

from .knowledge_audit_models import KnowledgeItemKind
from .knowledge_item_view_models import KnowledgeItemSummary, KnowledgeScopeProject
from .model_base import StrictModel
from .models import SourceApplication

# One page of the prompt lists at most this many held items, and one move
# takes at most this many; what can be chosen is not limited (dot P2-3).
MAX_MIGRATION_ITEMS = 100


class SessionMigrationTarget(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    source_application: SourceApplication
    session_id: str = Field(min_length=1, max_length=256)
    target_project_id: str = Field(min_length=1, max_length=128)


class SessionMigrationRead(SessionMigrationTarget):
    # False: only how many are held and how often this session already worked
    # in the project, for a task entry deciding whether to show its link.
    include_items: bool = True
    # A page of the held items, oldest first.
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=MAX_MIGRATION_ITEMS, ge=1, le=MAX_MIGRATION_ITEMS)


class SessionMigrationPreview(StrictModel):
    temporary_project_id: str
    target_project: KnowledgeScopeProject
    held_count: int = 0
    # Tasks of this session in the target project, the current one included:
    # 1 means the session has just linked to it.
    linked_task_count: int = 0
    items: list[KnowledgeItemSummary] = Field(default_factory=list)
    # Where the next page starts, or None when this page reaches the end.
    next_offset: int | None = None


class SessionMigrationItem(StrictModel):
    item_kind: KnowledgeItemKind
    item_id: str = Field(min_length=1, max_length=256)
    # The edit revision the prompt showed (knowledge_item_version).
    expected_version: int = Field(ge=0)


class SessionMigrationApply(SessionMigrationTarget):
    reason: str = Field(min_length=1, max_length=2000)
    items: list[SessionMigrationItem] = Field(min_length=1, max_length=MAX_MIGRATION_ITEMS)
    # The person's own console action, never an Agent's.
    operation_actor: Literal['human'] = 'human'

    @model_validator(mode='after')
    def unique_items(self):
        keys = [(item.item_kind, item.item_id) for item in self.items]
        if len(set(keys)) != len(keys):
            raise ValueError('each item is named once')
        return self


class SessionMigrationMoved(StrictModel):
    item_kind: KnowledgeItemKind
    item_id: str
    previous_scope: dict
    scope: dict


class SessionMigrationResult(StrictModel):
    target_project_id: str
    moved: list[SessionMigrationMoved]
