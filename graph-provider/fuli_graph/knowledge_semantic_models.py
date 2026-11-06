"""Requests and answers of the meaning index (rec#88)."""
from typing import Annotated

from pydantic import Field, model_validator

from .knowledge_audit_models import KnowledgeItemKind
from .model_base import StrictModel
from .knowledge_semantic_query import SemanticVectorValues

SEMANTIC_BATCH_LIMIT = 64
SemanticModelName = Annotated[str, Field(min_length=1, max_length=256)]
Sha256 = Annotated[str, Field(pattern=r'^[0-9a-f]{64}$')]


class SemanticPendingRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    model: SemanticModelName
    limit: int = Field(default=SEMANTIC_BATCH_LIMIT, ge=1, le=SEMANTIC_BATCH_LIMIT)
    # The `next` of the previous page; omitted for the first.
    after: str | None = Field(default=None, min_length=1, max_length=320)


class SemanticPendingItem(StrictModel):
    item_kind: KnowledgeItemKind
    item_id: str
    # None for an item no project owns, so the caller applies the project approval.
    personal_project_id: str | None
    text: str
    hash: str


class SemanticPendingPage(StrictModel):
    items: list[SemanticPendingItem]
    next: str | None


class SemanticVectorItem(StrictModel):
    item_kind: KnowledgeItemKind
    item_id: str = Field(min_length=1, max_length=256)
    hash: Sha256
    vector: SemanticVectorValues


class SemanticVectorWrite(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    model: SemanticModelName
    items: list[SemanticVectorItem] = Field(min_length=1, max_length=SEMANTIC_BATCH_LIMIT)

    @model_validator(mode='after')
    def validate_one_length(self):
        if len({len(item.vector) for item in self.items}) != 1:
            raise ValueError('every vector in one write must have the same length')
        if len({(item.item_kind, item.item_id) for item in self.items}) != len(self.items):
            raise ValueError('each item may appear once')
        return self


class SemanticVectorWriteResult(StrictModel):
    written: int = Field(ge=0)
    # The items whose text changed since their hash was computed, or that are gone.
    skipped: list[str]


class SemanticStatusRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    model: SemanticModelName


class SemanticStatus(StrictModel):
    total: int = Field(ge=0)
    done: int = Field(ge=0)

