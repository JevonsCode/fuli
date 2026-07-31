from typing import Literal

from pydantic import Field, model_validator

from .models import KnowledgeItemKind, KnowledgeOperationActor, StrictModel


class CommonKnowledgePromotionRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    parent_project_id: str = Field(min_length=1, max_length=128)
    item_kind: KnowledgeItemKind
    canonical_item_id: str = Field(min_length=1, max_length=256)
    duplicate_item_ids: list[str] = Field(min_length=1, max_length=31)
    reason: str = Field(min_length=1, max_length=2000)
    human_confirmation_reason: str = Field(min_length=1, max_length=2000)
    operation_actor: KnowledgeOperationActor = 'agent'

    @model_validator(mode='after')
    def validate_item_ids(self):
        if len(set(self.duplicate_item_ids)) != len(self.duplicate_item_ids):
            raise ValueError('duplicate item ids must be unique')
        if self.canonical_item_id in self.duplicate_item_ids:
            raise ValueError('canonical item cannot also be a duplicate')
        return self


class CommonKnowledgePromotionPreview(StrictModel):
    status: Literal['ready']
    personal_space_id: str
    parent_project_id: str
    item_kind: KnowledgeItemKind
    canonical_item_id: str
    duplicate_item_ids: list[str]
    source_project_ids: list[str]
    inheritance_mode: Literal['descendants'] = 'descendants'
    atomic: bool = True
    requires_human_confirmation: bool = True
    reason: str
    human_confirmation_reason: str


class CommonKnowledgePromotionResult(StrictModel):
    status: Literal['promoted']
    promotion_id: str
    personal_space_id: str
    parent_project_id: str
    item_kind: KnowledgeItemKind
    canonical_item_id: str
    invalidated_item_ids: list[str]
    source_project_ids: list[str]
    inheritance_mode: Literal['descendants'] = 'descendants'
    revision_ids: list[str]
    reason: str
    human_confirmation_reason: str
