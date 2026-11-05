"""Requests and answers of retrieval terms (rec#92)."""
from typing import Annotated

from pydantic import Field, field_validator, model_validator

from .knowledge_audit_models import KnowledgeItemKind
from .knowledge_semantic_models import Sha256
from .model_base import StrictModel

RETRIEVAL_BATCH_LIMIT = 64
MAX_TERMS = 24
MAX_TERM_CHARS = 120
MAX_CONTEXT_CHARS = 300
SpaceId = Annotated[str, Field(min_length=1, max_length=128)]


class RetrievalCandidatesRequest(StrictModel):
    personal_space_id: SpaceId
    # Only this project's items; omitted for every project and items no project owns.
    personal_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    limit: int = Field(default=RETRIEVAL_BATCH_LIMIT, ge=1, le=RETRIEVAL_BATCH_LIMIT)
    after: str | None = Field(default=None, min_length=1, max_length=320)
    # Only items without terms for their current text.
    missing_only: bool = True


class RetrievalCandidate(StrictModel):
    item_kind: KnowledgeItemKind
    item_id: str
    personal_project_id: str | None
    title: str
    # The item's own words, which the terms are made from.
    text: str
    has_terms: bool
    # Of `text`: a write whose hash no longer matches is skipped.
    hash: str


class RetrievalCandidatesPage(StrictModel):
    items: list[RetrievalCandidate]
    next: str | None


class RetrievalTermsItem(StrictModel):
    item_kind: KnowledgeItemKind
    item_id: str = Field(min_length=1, max_length=256)
    hash: Sha256
    terms: list[str] = Field(min_length=1, max_length=MAX_TERMS)
    context: str | None = Field(default=None, max_length=MAX_CONTEXT_CHARS)

    @field_validator('terms')
    @classmethod
    def clean_terms(cls, terms: list[str]) -> list[str]:
        cleaned = list(dict.fromkeys(term.strip() for term in terms if term.strip()))
        if not cleaned:
            raise ValueError('at least one term is required')
        if any(len(term) > MAX_TERM_CHARS for term in cleaned):
            raise ValueError(f'a term has at most {MAX_TERM_CHARS} characters')
        return cleaned

    @field_validator('context')
    @classmethod
    def clean_context(cls, context: str | None) -> str | None:
        return context.strip() or None if context else None


class RetrievalTermsWrite(StrictModel):
    personal_space_id: SpaceId
    items: list[RetrievalTermsItem] = Field(min_length=1, max_length=RETRIEVAL_BATCH_LIMIT)

    @model_validator(mode='after')
    def validate_unique(self):
        if len({(item.item_kind, item.item_id) for item in self.items}) != len(self.items):
            raise ValueError('each item may appear once')
        return self


class RetrievalTermsWriteResult(StrictModel):
    written: int = Field(ge=0)
    # The items whose text changed since their hash was computed, or that are gone.
    skipped: list[str]


class RetrievalStatsRequest(StrictModel):
    personal_space_id: SpaceId
    personal_project_id: str | None = Field(default=None, min_length=1, max_length=128)


class RetrievalStats(StrictModel):
    items: int = Field(ge=0)
    with_terms: int = Field(ge=0)
    # Characters of the items' own words, all of them and those still without terms:
    # what an estimate of the fill's cost starts from.
    chars: int = Field(ge=0)
    missing_chars: int = Field(ge=0)
