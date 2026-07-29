from pydantic import Field, model_validator

from .models import (
    ConfirmationStatus,
    KnowledgeItemKind,
    KnowledgeUseKind,
    StrictModel,
)


class KnowledgeUsageItem(StrictModel):
    item_id: str = Field(min_length=1, max_length=256)
    item_kind: KnowledgeItemKind
    use_kind: KnowledgeUseKind


class KnowledgeUsageCreate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    task_id: str = Field(min_length=1, max_length=256)
    session_id: str | None = Field(default=None, min_length=1, max_length=256)
    tool_name: str | None = Field(default=None, min_length=1, max_length=128)
    items: list[KnowledgeUsageItem] = Field(min_length=1, max_length=200)

    @model_validator(mode='after')
    def validate_usage_items(self):
        identities = {
            (item.item_kind, item.item_id, item.use_kind)
            for item in self.items
        }
        if len(identities) != len(self.items):
            raise ValueError('knowledge usage items must be unique')
        return self


class KnowledgeUsageItemResult(StrictModel):
    item_id: str
    item_kind: KnowledgeItemKind
    recorded: bool
    promoted: bool = False
    confirmation_status: ConfirmationStatus
    utility_score: float = Field(ge=0, le=1)
    confidence_score: float = Field(ge=0, le=1)
    qualified_use_count: int = Field(ge=0)
    distinct_task_count: int = Field(ge=0)
    usage_generation: int = Field(ge=1)


class KnowledgeUsageResult(StrictModel):
    recorded_count: int = Field(ge=0, le=200)
    duplicate_count: int = Field(ge=0, le=200)
    promoted_count: int = Field(ge=0, le=200)
    items: list[KnowledgeUsageItemResult] = Field(max_length=200)
