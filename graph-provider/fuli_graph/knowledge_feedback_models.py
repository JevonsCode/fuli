from typing import Literal

from pydantic import Field, field_validator, model_validator

from .models import (
    ConfirmationStatus,
    KnowledgeFeedbackKind,
    KnowledgeItemKind,
    StrictModel,
    _validated_source_uri,
)

KnowledgeFeedbackReporterKind = Literal[
    'user',
    'agent',
    'authoritative_source',
]


class KnowledgeFeedbackItem(StrictModel):
    item_id: str = Field(min_length=1, max_length=256)
    item_kind: KnowledgeItemKind
    feedback_kind: KnowledgeFeedbackKind
    reason: str = Field(min_length=1, max_length=2000)
    evidence_summary: str = Field(min_length=1, max_length=4096)
    reported_by_kind: KnowledgeFeedbackReporterKind
    source_uri: str | None = Field(default=None, min_length=1, max_length=2048)

    @field_validator('source_uri')
    @classmethod
    def validate_source_uri(cls, value):
        return _validated_source_uri(value) if value is not None else None


class KnowledgeFeedbackCreate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    task_id: str = Field(min_length=1, max_length=256)
    session_id: str | None = Field(default=None, min_length=1, max_length=256)
    tool_name: str | None = Field(default=None, min_length=1, max_length=128)
    items: list[KnowledgeFeedbackItem] = Field(min_length=1, max_length=200)

    @model_validator(mode='after')
    def validate_feedback_items(self):
        identities = {
            (item.item_kind, item.item_id, item.feedback_kind)
            for item in self.items
        }
        if len(identities) != len(self.items):
            raise ValueError('knowledge feedback items must be unique')
        return self


class KnowledgeFeedbackItemResult(StrictModel):
    item_id: str
    item_kind: KnowledgeItemKind
    feedback_kind: KnowledgeFeedbackKind
    recorded: bool
    confirmation_status: ConfirmationStatus
    utility_score: float = Field(ge=0, le=1)
    confidence_score: float = Field(ge=0, le=1)
    negative_evidence_count: int = Field(ge=0)
    requires_attention: bool
    usage_generation: int = Field(ge=1)


class KnowledgeFeedbackResult(StrictModel):
    recorded_count: int = Field(ge=0, le=200)
    duplicate_count: int = Field(ge=0, le=200)
    items: list[KnowledgeFeedbackItemResult] = Field(max_length=200)
