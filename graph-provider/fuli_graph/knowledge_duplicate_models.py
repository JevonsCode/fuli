"""The periodic duplicate-merge pass (knowledge_duplicates): its request and
what it merged."""
from typing import Literal

from pydantic import Field

from .knowledge_audit_models import KnowledgeItemKind
from .model_base import StrictModel


class DuplicateMergeRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    limit: int = Field(default=50, ge=1, le=200)


class DuplicateMerged(StrictModel):
    item_kind: KnowledgeItemKind
    item_id: str
    kept_item_id: str
    rule: Literal['same_text', 'covers', 'same_meaning']


class DuplicateMergeResult(StrictModel):
    merged: list[DuplicateMerged] = Field(default_factory=list)
