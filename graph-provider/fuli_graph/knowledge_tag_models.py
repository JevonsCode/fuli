"""Open tag vocabulary contracts: tags help find knowledge, never authorize or confirm it.

The governance fields are fixed; the words are open. A tag lives in one
namespace: the person's own vocabulary (personal), one personal project
(project) or, once governance exists, a shared vocabulary (shared, refused for
now). Status starts at provisional for Agent-proposed tags and active for a
person's own; merged and retired arrive with governance.
"""
import unicodedata
from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator, model_validator

from .knowledge_audit_models import KnowledgeItemKind, KnowledgeOperationActor
from .model_base import StrictModel
from .model_validation import reject_credentials
from .models import SourceApplication
from .name_identity import display_name, identity_key

TagNamespace = Literal['personal', 'project', 'shared']
StoredTagNamespace = Literal['personal', 'project']
TagStatus = Literal['provisional', 'active']
TagMatch = Literal['exact', 'alias', 'similar']
TagMatchBasis = Literal['name', 'alias', 'description', 'semantic']
TAG_NAME_MAX = 80
_FORBIDDEN_CATEGORIES = {'Cc', 'Cs', 'Co', 'Cn'}


def _tag_text(value: str, label: str) -> str:
    if any(unicodedata.category(character) in _FORBIDDEN_CATEGORIES
           and not character.isspace() for character in value):
        raise ValueError(f'{label} must not contain control or unassigned characters')
    name = display_name(value)
    if not identity_key(name) or len(name) > TAG_NAME_MAX:
        raise ValueError(f'{label} must contain 1 to {TAG_NAME_MAX} visible characters')
    return name


class KnowledgeTagScope(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    # Without a project only the personal vocabulary is visible.
    personal_project_id: str | None = Field(default=None, min_length=1, max_length=128)


class KnowledgeTagResolve(KnowledgeTagScope):
    query: str = Field(min_length=1, max_length=TAG_NAME_MAX * 2)
    limit: int = Field(default=5, ge=1, le=20)

    @field_validator('query')
    @classmethod
    def visible_query(cls, value: str) -> str:
        return _tag_text(value[:TAG_NAME_MAX], 'query')


class _KnowledgeTagWrite(KnowledgeTagScope):
    operation_actor: KnowledgeOperationActor = 'agent'
    source_application: SourceApplication | None = None

    @model_validator(mode='after')
    def no_credentials(self):
        reject_credentials(self, 'Knowledge tag')
        return self


class KnowledgeTagCreate(_KnowledgeTagWrite):
    name: str = Field(min_length=1, max_length=TAG_NAME_MAX * 2)
    description: str | None = Field(default=None, min_length=1, max_length=500)
    # Default: the current project when there is one, else the personal vocabulary.
    namespace: TagNamespace | None = None
    language: str | None = Field(default=None, pattern=r'^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$',
                                 max_length=35)
    reason: str = Field(min_length=1, max_length=500)
    # Similar candidates the caller judged to mean something else (G4-3).
    distinct_from: list[str] = Field(default_factory=list, max_length=50)

    @field_validator('name')
    @classmethod
    def visible_name(cls, value: str) -> str:
        return _tag_text(value, 'name')


class KnowledgeTagAliasCreate(_KnowledgeTagWrite):
    tag_id: str = Field(min_length=1, max_length=128)
    alias: str = Field(min_length=1, max_length=TAG_NAME_MAX * 2)
    reason: str = Field(min_length=1, max_length=500)

    @field_validator('alias')
    @classmethod
    def visible_alias(cls, value: str) -> str:
        return _tag_text(value, 'alias')


class KnowledgeTagLinkChange(_KnowledgeTagWrite):
    tag_id: str = Field(min_length=1, max_length=128)
    item_kind: KnowledgeItemKind
    item_id: str = Field(min_length=1, max_length=256)


class KnowledgeTagMetricsQuery(KnowledgeTagScope):
    # Only the local owner's console asks across every project; Agent tools never do.
    include_all_projects: bool = False
    days: int = Field(default=30, ge=1, le=366)


class KnowledgeTagSource(StrictModel):
    kind: Literal['agent', 'human']
    application: SourceApplication | None
    reason: str


class KnowledgeTagRecord(StrictModel):
    id: str
    name: str
    namespace: StoredTagNamespace
    status: TagStatus
    description: str | None
    aliases: list[str]
    language: str | None
    version: int
    source: KnowledgeTagSource
    distinct_from: list[str]
    created_at: datetime
    updated_at: datetime


class KnowledgeTagCandidate(StrictModel):
    id: str
    name: str
    namespace: StoredTagNamespace
    status: TagStatus
    match: TagMatch
    basis: TagMatchBasis
    description: str | None
    aliases: list[str]


class KnowledgeTagReference(StrictModel):
    id: str
    name: str
    namespace: StoredTagNamespace
    status: TagStatus


class KnowledgeTagResolveResult(StrictModel):
    query: str
    candidates: list[KnowledgeTagCandidate]


class KnowledgeTagCreateResult(StrictModel):
    outcome: Literal['created', 'existing', 'needs_decision']
    tag: KnowledgeTagRecord | None
    candidates: list[KnowledgeTagCandidate]
    guidance: str | None = None


class KnowledgeTagAliasResult(StrictModel):
    outcome: Literal['added', 'unchanged', 'conflict']
    tag: KnowledgeTagRecord
    conflict: KnowledgeTagCandidate | None = None


class KnowledgeTagLinkResult(StrictModel):
    outcome: Literal['attached', 'detached', 'unchanged']
    item_kind: KnowledgeItemKind
    item_id: str
    tags: list[KnowledgeTagReference]


class KnowledgeTagCount(StrictModel):
    namespace: StoredTagNamespace
    status: TagStatus
    count: int


class KnowledgeTagCreatedDay(StrictModel):
    date: str
    created: int
    provisional: int


class KnowledgeTagMetrics(StrictModel):
    scope: Literal['visible', 'all']
    days: int
    counts: list[KnowledgeTagCount]
    created_by_day: list[KnowledgeTagCreatedDay]
