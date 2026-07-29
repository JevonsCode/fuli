from datetime import datetime
from typing import Literal

from pydantic import Field, model_validator

from .models import (
    KnowledgeItemKind,
    KnowledgeOperationActor,
    ProjectRelationType,
    StrictModel,
)

KnowledgeProjectActionMode = Literal['create', 'existing']
KnowledgeProjectReferenceStatus = Literal[
    'active',
    'pending_conflict',
    'rejected',
    'duplicate',
]
KnowledgeConflictResolution = Literal[
    'defer',
    'keep_target',
    'use_source',
    'coexist',
]
KnowledgeProjectMatchKind = Literal[
    'none',
    'already_linked',
    'exact_duplicate',
    'conflict',
]


class KnowledgeProjectPreviewRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    item_kind: Literal['entity'] = 'entity'
    mode: KnowledgeProjectActionMode = 'existing'
    target_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    new_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    new_project_name: str | None = Field(default=None, min_length=1, max_length=160)
    new_project_purpose: str | None = Field(default=None, max_length=4096)
    keep_source_relation: bool = True
    relation_type: ProjectRelationType = 'RELATED_TO'
    conflict_resolution: KnowledgeConflictResolution = 'defer'
    reason: str | None = Field(default=None, min_length=1, max_length=2000)

    @model_validator(mode='after')
    def validate_target(self):
        if self.mode == 'existing' and not self.target_project_id:
            raise ValueError('existing mode requires target_project_id')
        if self.mode == 'create' and not (
            self.new_project_id and self.new_project_name
        ):
            raise ValueError('create mode requires new project id and name')
        return self


class KnowledgeProjectActionRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    item_kind: Literal['entity'] = 'entity'
    mode: KnowledgeProjectActionMode
    target_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    new_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    new_project_name: str | None = Field(default=None, min_length=1, max_length=160)
    new_project_purpose: str | None = Field(default=None, max_length=4096)
    keep_source_relation: bool = True
    relation_type: ProjectRelationType = 'RELATED_TO'
    conflict_resolution: KnowledgeConflictResolution = 'defer'
    reason: str = Field(min_length=1, max_length=2000)
    operation_actor: KnowledgeOperationActor = 'agent'

    @model_validator(mode='after')
    def validate_target(self):
        if self.mode == 'existing' and not self.target_project_id:
            raise ValueError('existing mode requires target_project_id')
        if self.mode == 'create' and not (
            self.new_project_id and self.new_project_name
        ):
            raise ValueError('create mode requires new project id and name')
        return self


class KnowledgeProjectMatch(StrictModel):
    kind: KnowledgeProjectMatchKind
    reason: str
    item_id: str | None = None
    item_name: str | None = None
    item_summary: str | None = None


class KnowledgeProjectPreviewRecord(StrictModel):
    item_id: str
    item_name: str
    item_summary: str
    source_project_id: str | None = None
    target_project_id: str
    match: KnowledgeProjectMatch
    default_resolution: KnowledgeConflictResolution = 'defer'


class KnowledgeProjectReferenceRecord(StrictModel):
    id: str
    item_id: str
    item_kind: KnowledgeItemKind
    project_id: str
    source_project_id: str | None = None
    status: KnowledgeProjectReferenceStatus
    matched_item_id: str | None = None
    reason: str
    created_at: datetime
    updated_at: datetime


class KnowledgeConflictRecord(StrictModel):
    id: str
    item_id: str
    target_item_id: str
    source_project_id: str | None = None
    target_project_id: str
    status: Literal['pending', 'resolved']
    resolution: KnowledgeConflictResolution
    reason: str
    created_at: datetime
    updated_at: datetime


class KnowledgeProjectActionResult(StrictModel):
    status: Literal[
        'created',
        'linked',
        'already_linked',
        'duplicate_reused',
        'conflict_pending',
        'conflict_resolved',
    ]
    source_project_id: str | None = None
    target_project_id: str
    project_created: bool = False
    project_relation_created: bool = False
    match: KnowledgeProjectMatch
    reference: KnowledgeProjectReferenceRecord | None = None
    conflict: KnowledgeConflictRecord | None = None
