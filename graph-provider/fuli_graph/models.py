from datetime import datetime
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import (
    AliasChoices,
    Field,
    field_validator,
    model_validator,
)

from .knowledge_audit_models import (
    HumanChangeStatus,
    KnowledgeAgentReviewCreate,
    KnowledgeAgentViewCreate,
    KnowledgeAgentViewItem,
    KnowledgeAgentViewResult,
    KnowledgeAssignmentChange,
    KnowledgeAssignmentRecord,
    KnowledgeAuditAction,
    KnowledgeAuditRecord,
    KnowledgeFeedbackKind,
    KnowledgeHumanChangeItem,
    KnowledgeHumanChangeSearchRequest,
    KnowledgeHumanChangeSearchResult,
    KnowledgeItemKind,
    KnowledgeOperationActor,
    KnowledgeRevisionAction,
    KnowledgeRevisionRecord,
    KnowledgeUseKind,
    PreferenceScope,
    PreferenceScopeChange,
)
from .model_base import StrictModel
from .knowledge_weight_models import KnowledgeWeightView
from .provider_values import json_object
from .project_profile_authors import AuthoredField, ProjectFieldAuthor, default_field_authors
from .model_validation import (
    complete_epistemic_state,
    normalize_provider_url,
    reject_credentials,
    require_public_eligible_episode,
    unique_text_list,
)

Role = Literal['reader', 'contributor', 'maintainer']
SpaceKind = Literal['personal', 'project']
SpaceVisibility = Literal['private', 'public']
Sensitivity = Literal['normal', 'private', 'restricted']
ProjectLifecycle = Literal['planned', 'active', 'maintenance', 'archived']
ProjectSourceKind = Literal[
    'prd',
    'product_document',
    'technical_document',
    'frontend_repository',
    'backend_repository',
    'repository',
    'design',
    'runbook',
    'monitoring',
    'issue_tracker',
    'other',
]
AssessmentState = Literal['confirmed', 'inferred']
AssessmentLabel = Literal[
    'needs_clarification',
    'partially_documented',
    'well_documented',
]
ProjectRelationType = Literal[
    'PART_OF',
    'USES_KNOWLEDGE_FROM',
    'DEPENDS_ON',
    'PROVIDES_TO',
    'SHARES_CAPABILITY_WITH',
    'SUCCESSOR_OF',
    'RELATED_TO',
]
ProjectRelationStatus = Literal['pending', 'active', 'rejected']
KnowledgeInheritanceMode = Literal[
    'local_only',
    'descendants',
    'selected_projects',
]
KnowledgeContentRevisionAction = Literal[
    'confirm',
    'update',
    'invalidate',
    'link_replacement',
    'restore',
    # A person's negative feedback that also ends the item's validity
    # (rec#5 C8): it leaves current answers and keeps its history.
    'mark_outdated',
    # A person's review of a conclusion whose basis changed: it still holds,
    # so a new version rests on the new basis (D-20.7).
    'reaffirm',
    # A person says, later, that an edit of this basis changed its meaning.
    'mark_meaning_changed',
]
# Whether a person's edit or confirmation of a basis changed what conclusions
# drawn from it mean (D-20.7). Absent means it changed; only a person may say
# it was the wording alone.
BasisMeaning = Literal['changed', 'wording_only']
# The knowledge an item was concluded from (rec#5 C8-4): when one of them is
# marked outdated, the conclusion stops being delivered as a current fact.
MAX_DERIVED_FROM = 8
KnowledgeConfirmationGroupKind = Literal['source', 'session']
EpistemicQuadrant = Literal[
    'known_known',
    'known_unknown',
    'unknown_known',
    'unknown_unknown',
]
EpistemicStatus = Literal['confirmed', 'observed', 'exploratory']
ConfirmationStatus = Literal['confirmed', 'agent_confirmed', 'pending']
ConfirmationActorKind = Literal['user', 'agent', 'authoritative_source', 'import']
PersonalProfileAspect = Literal['taste', 'personality', 'judgment_preference']
ScopedPreferenceScope = Literal['global', 'project', 'agent']
# Who the content came from: the user's own words, or an Agent's inference
# (rec#20). It never confirms anything; confirmation stays separate.
ContentSource = Literal['user_explicit', 'agent_inferred']
PreferenceConflictQueueStatus = Literal['ai_pending', 'resolved']
PreferenceConflictResolutionAction = Literal[
    'merge',
    'keep_left',
    'keep_right',
    'split_scope',
]
SourceApplication = Literal[
    'codex', 'claude', 'claude_code', 'cursor', 'kiro', 'opencode', 'antigravity', 'other'
]


def _validated_source_uri(value: str) -> str:
    if any(
        character.isspace() or ord(character) < 32 or ord(character) == 127
        for character in value
    ):
        raise ValueError(
            'source_uri must be an absolute HTTP(S) URI without credentials'
        )
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
    except ValueError as error:
        raise ValueError(
            'source_uri must be an absolute HTTP(S) URI without credentials'
        ) from error
    if (
        parsed.scheme.casefold() not in {'http', 'https'}
        or not parsed.netloc
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ValueError(
            'source_uri must be an absolute HTTP(S) URI without credentials'
        )
    return value


def _validate_inheritance(
    mode: KnowledgeInheritanceMode,
    project_ids: list[str],
    profile_aspect: PersonalProfileAspect | None,
) -> None:
    if len(set(project_ids)) != len(project_ids):
        raise ValueError('inherited project ids must be unique')
    if any(not item or len(item) > 128 for item in project_ids):
        raise ValueError('inherited project ids must contain 1 to 128 characters')
    if mode == 'selected_projects' and not project_ids:
        raise ValueError(
            'selected_projects inheritance requires at least one project id'
        )
    if mode != 'selected_projects' and project_ids:
        raise ValueError(
            'inherited project ids are only valid for selected_projects inheritance'
        )


class ConfirmationActor(StrictModel):
    kind: ConfirmationActorKind
    label: str | None = Field(default=None, min_length=1, max_length=160)


class ConfirmationBasis(StrictModel):
    existence_reason: str = Field(min_length=1, max_length=4096)
    quadrant_reason: str = Field(min_length=1, max_length=4096)
    proposed_by: ConfirmationActor
    confirmed_by: ConfirmationActor | None = None
    confirmed_at: datetime | None = None
    agent_policy_version: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
    )

    @model_validator(mode='after')
    def validate_confirmation_actor(self):
        if bool(self.confirmed_by) != bool(self.confirmed_at):
            raise ValueError('confirmed_by and confirmed_at must be recorded together')
        return self


def stored_confirmation_basis(value) -> ConfirmationBasis | None:
    """Read a stored basis; missing or invalid data reads as no basis."""
    data = json_object(value)
    if not data:
        return None
    try:
        return ConfirmationBasis.model_validate(data)
    except ValueError:
        return None


def _validate_confirmation_state(
    status: ConfirmationStatus,
    basis: ConfirmationBasis,
) -> None:
    has_confirmation = bool(basis.confirmed_by and basis.confirmed_at)
    if status == 'pending':
        if has_confirmation or basis.agent_policy_version:
            raise ValueError(
                'pending knowledge cannot retain a confirmer, confirmation time, '
                'or agent policy'
            )
        return
    if not has_confirmation:
        raise ValueError(
            f'{status} knowledge requires a confirmer and confirmation time'
        )
    if status == 'confirmed':
        if basis.confirmed_by.kind not in {'user', 'authoritative_source'}:
            raise ValueError(
                'an agent or import cannot confirm human-confirmed knowledge; '
                'a user or authoritative source is required'
            )
        if basis.agent_policy_version:
            raise ValueError(
                'human-confirmed knowledge cannot retain an agent policy version'
            )
        return
    if basis.confirmed_by.kind != 'agent' or not basis.agent_policy_version:
        raise ValueError(
            'agent-confirmed knowledge requires an agent confirmer and policy version'
        )


def _legacy_epistemic_status(
    status: ConfirmationStatus,
    quadrant: EpistemicQuadrant,
) -> EpistemicStatus:
    if status == 'confirmed':
        return 'confirmed'
    return 'exploratory' if quadrant == 'unknown_unknown' else 'observed'


def _default_quadrant_reason(quadrant: EpistemicQuadrant) -> str:
    return {
        'known_known': 'The item was explicitly expressed when it was captured.',
        'known_unknown': 'The item was captured as an explicit unresolved question.',
        'unknown_known': 'The item was inferred from examples, behaviour, or reactions.',
        'unknown_unknown': 'The item surfaced during blind-spot or open exploration.',
    }[quadrant]


class BootstrapRequest(StrictModel):
    principal_name: str = Field(min_length=1, max_length=160)


class BootstrapResult(StrictModel):
    principal_id: str
    access_token: str


class PrincipalCreate(StrictModel):
    name: str = Field(min_length=1, max_length=160)


class PrincipalResult(StrictModel):
    principal_id: str
    access_token: str


class ProjectSource(StrictModel):
    key: str = Field(min_length=1, max_length=128)
    kind: ProjectSourceKind
    title: str = Field(min_length=1, max_length=512)
    uri: str | None = Field(default=None, max_length=2048)
    summary: str | None = Field(default=None, max_length=4096)
    sensitivity: Sensitivity = 'normal'


class AssessmentDimension(StrictModel):
    key: str = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=256)
    score: int = Field(ge=0, le=100)
    state: AssessmentState
    evidence: list[str] = Field(default_factory=list, max_length=32)

    @model_validator(mode='before')
    @classmethod
    def accept_legacy_missing_fields(cls, value):
        if not isinstance(value, dict):
            return value
        compatible = dict(value)
        compatible.pop('missing', None)
        compatible.pop('recommendation', None)
        if compatible.get('state') == 'missing':
            compatible['state'] = 'inferred'
        return compatible


class ProjectAssessment(StrictModel):
    score: int = Field(ge=0, le=100)
    label: AssessmentLabel
    confirmed: list[str] = Field(default_factory=list, max_length=64)
    inferred: list[str] = Field(default_factory=list, max_length=64)
    dimensions: list[AssessmentDimension] = Field(default_factory=list, max_length=16)
    analyzed_at: datetime

    @model_validator(mode='before')
    @classmethod
    def accept_legacy_missing_summary(cls, value):
        if not isinstance(value, dict):
            return value
        compatible = dict(value)
        compatible.pop('missing', None)
        return compatible


class ProjectBriefDraft(StrictModel):
    source: Literal['readme', 'first_task']
    label: Literal['AI draft'] = 'AI draft'
    editable: Literal[True] = True


class ProjectProfile(StrictModel):
    name: str = Field(min_length=1, max_length=160)
    purpose: str | None = Field(default=None, max_length=4096)
    scope: str | None = Field(default=None, max_length=4096)
    technical_summary: str | None = Field(default=None, max_length=4096)
    lifecycle: ProjectLifecycle = 'planned'
    sources: list[ProjectSource] = Field(default_factory=list, max_length=64)
    boundaries: list[str] = Field(default_factory=list, max_length=64)
    assessment: ProjectAssessment | None = None
    brief_draft: ProjectBriefDraft | None = None
    authors: dict[AuthoredField, ProjectFieldAuthor] = Field(default_factory=dict)

    @model_validator(mode='after')
    def default_authors(self):
        self.authors = default_field_authors(self)
        return self

    @property
    def has_brief(self) -> bool:
        return any(value and value.strip() for value in
                   [self.purpose, self.scope, *self.boundaries])

    @model_validator(mode='after')
    def reject_credentials(self):
        reject_credentials(self, 'Project profile')
        return self


class ProjectReleaseCreate(StrictModel):
    version: str = Field(
        min_length=1,
        max_length=64,
        pattern=r'^[0-9A-Za-z][0-9A-Za-z._-]*$',
    )
    summary: str = Field(min_length=1, max_length=4096)


class ProjectReleaseRecord(StrictModel):
    id: str
    project_id: str
    version: str
    summary: str
    publisher_id: str
    publisher_name: str
    published_at: datetime


class SpaceCreate(StrictModel):
    name: str = Field(min_length=1, max_length=160)
    kind: SpaceKind
    description: str | None = Field(default=None, max_length=2000)
    publication_key: str | None = Field(default=None, min_length=8, max_length=256)
    profile: ProjectProfile | None = None
    release: ProjectReleaseCreate | None = None


class SpaceRecord(StrictModel):
    id: str
    name: str
    kind: SpaceKind
    group_id: str
    description: str | None
    visibility: SpaceVisibility
    owner_id: str
    role: Role
    publication_key: str | None = None
    can_manage: bool = False
    profile: ProjectProfile | None = None
    current_release: ProjectReleaseRecord | None = None
    created_at: datetime


class ProjectDeleteResult(StrictModel):
    project_id: str
    project_name: str
    deleted: bool


class PersonalProjectUpsert(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1, max_length=128)
    profile: ProjectProfile
    # A person creating a new project must never overwrite an existing one.
    create_only: bool = False

    @model_validator(mode='after')
    def require_project_brief(self):
        if self.create_only and not self.profile.has_brief:
            raise ValueError('Project brief requires non-empty purpose, scope, or boundaries')
        return self


class PersonalProjectRecord(StrictModel):
    project_id: str
    personal_space_id: str
    scope_type: Literal['registered', 'temporary'] = 'registered'
    publication_key: str
    profile: ProjectProfile
    created_at: datetime
    updated_at: datetime


class ProjectRelationCreate(StrictModel):
    target_project_id: str = Field(min_length=1, max_length=128)
    relation_type: ProjectRelationType
    note: str | None = Field(default=None, max_length=2000)


class ProjectRelationRecord(StrictModel):
    id: str
    source_project_id: str
    target_project_id: str
    relation_type: ProjectRelationType
    status: ProjectRelationStatus
    note: str | None
    created_by: str
    created_at: datetime
    decided_by: str | None = None
    decided_at: datetime | None = None


class ProjectRelationDecision(StrictModel):
    decision: Literal['confirm', 'reject']
    note: str | None = Field(default=None, max_length=2000)


class MembershipCreate(StrictModel):
    principal_id: str = Field(min_length=1, max_length=128)
    role: Role


class MembershipRecord(StrictModel):
    project_id: str
    principal_id: str
    role: Role
    created_at: datetime


class SubscriptionCreate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1, max_length=128)
    provider_url: str = Field(min_length=8, max_length=2048)
    project_name: str = Field(min_length=1, max_length=160)

    @field_validator('provider_url')
    @classmethod
    def validate_provider_url(cls, value: str) -> str:
        return normalize_provider_url(value)


class SubscriptionRecord(StrictModel):
    id: str
    personal_space_id: str
    project_id: str
    provider_url: str
    project_name: str
    created_at: datetime


class SubscriptionDeleteResult(StrictModel):
    project_id: str
    deleted: bool


class EntityInput(StrictModel):
    key: str = Field(min_length=1, max_length=256)
    name: str = Field(min_length=1, max_length=512)
    type: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z][A-Za-z0-9_]*$')
    summary: str = Field(default='', max_length=4096)
    origin_quadrant: EpistemicQuadrant = 'known_known'
    current_quadrant: EpistemicQuadrant | None = None
    epistemic_status: EpistemicStatus = 'confirmed'
    confirmation_status: ConfirmationStatus | None = None
    confirmation_basis: ConfirmationBasis | None = None
    reasoning_summary: str | None = Field(default=None, max_length=4096)
    profile_aspect: PersonalProfileAspect | None = None
    inheritance_mode: KnowledgeInheritanceMode = 'local_only'
    inherited_project_ids: list[str] = Field(default_factory=list, max_length=32)
    content_source: ContentSource | None = None
    derived_from: list[str] = Field(default_factory=list, max_length=MAX_DERIVED_FROM)
    attributes: dict[str, Any] = Field(default_factory=dict)

    @field_validator('derived_from')
    @classmethod
    def validate_derived_from(cls, value: list[str]) -> list[str]:
        return unique_text_list(value, 'derived_from', maximum=256)

    @field_validator('attributes')
    @classmethod
    def bound_attributes(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(value) > 32:
            raise ValueError('an entity may contain at most 32 attributes')
        for key in ('searchTerms', 'search_terms'):
            if key not in value:
                continue
            terms = value[key]
            if (
                not isinstance(terms, list)
                or not terms
                or len(terms) > 32
                or any(
                    not isinstance(term, str)
                    or not term.strip()
                    or len(term) > 256
                    for term in terms
                )
            ):
                raise ValueError(
                    'entity search terms must be 1 to 32 non-empty strings '
                    'of at most 256 characters'
                )
        return value

    @model_validator(mode='after')
    def validate_inheritance(self):
        _validate_inheritance(
            self.inheritance_mode,
            self.inherited_project_ids,
            self.profile_aspect,
        )
        return self

    @model_validator(mode='after')
    def complete_epistemic_state(self):
        self.current_quadrant = complete_epistemic_state(
            origin_quadrant=self.origin_quadrant,
            current_quadrant=self.current_quadrant,
            epistemic_status=self.epistemic_status,
            reasoning_summary=self.reasoning_summary,
            profile_aspect=self.profile_aspect,
        )
        return self


class RelationshipInput(StrictModel):
    key: str = Field(min_length=1, max_length=256)
    source: str = Field(min_length=1, max_length=256)
    target: str = Field(min_length=1, max_length=256)
    type: str = Field(min_length=1, max_length=64, pattern=r'^[A-Z][A-Z0-9_]*$')
    fact: str = Field(min_length=1, max_length=8192)
    valid_at: datetime | None = None
    invalid_at: datetime | None = None
    supersedes: list[str] = Field(default_factory=list, max_length=32)
    confidence: float = Field(default=1, ge=0, le=1)
    origin_quadrant: EpistemicQuadrant = 'known_known'
    current_quadrant: EpistemicQuadrant | None = None
    epistemic_status: EpistemicStatus = 'confirmed'
    confirmation_status: ConfirmationStatus | None = None
    confirmation_basis: ConfirmationBasis | None = None
    reasoning_summary: str | None = Field(default=None, max_length=4096)
    profile_aspect: PersonalProfileAspect | None = None
    inheritance_mode: KnowledgeInheritanceMode = 'local_only'
    inherited_project_ids: list[str] = Field(default_factory=list, max_length=32)
    content_source: ContentSource | None = None
    derived_from: list[str] = Field(default_factory=list, max_length=MAX_DERIVED_FROM)
    attributes: dict[str, Any] = Field(default_factory=dict)

    @field_validator('derived_from')
    @classmethod
    def validate_derived_from(cls, value: list[str]) -> list[str]:
        return unique_text_list(value, 'derived_from', maximum=256)

    @model_validator(mode='after')
    def validate_interval(self):
        if self.valid_at and self.invalid_at and self.invalid_at < self.valid_at:
            raise ValueError('invalid_at must not be earlier than valid_at')
        self.current_quadrant = complete_epistemic_state(
            origin_quadrant=self.origin_quadrant,
            current_quadrant=self.current_quadrant,
            epistemic_status=self.epistemic_status,
            reasoning_summary=self.reasoning_summary,
            profile_aspect=self.profile_aspect,
        )
        _validate_inheritance(
            self.inheritance_mode,
            self.inherited_project_ids,
            self.profile_aspect,
        )
        return self


class StructuredEpisode(StrictModel):
    idempotency_key: str = Field(min_length=8, max_length=256)
    session_id: str = Field(min_length=1, max_length=256)
    name: str = Field(min_length=1, max_length=512)
    source_kind: str = Field(min_length=1, max_length=128)
    source_description: str = Field(min_length=1, max_length=1024)
    source_uri: str | None = Field(default=None, min_length=1, max_length=2048)
    source_application: SourceApplication | None = None
    source_turn_id: str | None = Field(default=None, min_length=1, max_length=256)
    source_excerpt: str | None = Field(default=None, min_length=1, max_length=2048)
    reference_time: datetime
    summary: str = Field(default='', max_length=8192)
    sensitivity: Sensitivity = 'normal'
    entities: list[EntityInput] = Field(min_length=1, max_length=128)
    relationships: list[RelationshipInput] = Field(default_factory=list, max_length=256)

    @field_validator('source_uri')
    @classmethod
    def validate_source_uri(cls, value: str | None) -> str | None:
        return _validated_source_uri(value) if value is not None else None

    @model_validator(mode='after')
    def complete_confirmation_state(self):
        proposer = ConfirmationActor(
            kind='agent' if self.source_application else 'import',
            label=self.source_application or self.source_kind,
        )
        for item in [*self.entities, *self.relationships]:
            if item.confirmation_basis is None:
                item.confirmation_basis = ConfirmationBasis(
                    existence_reason=self.source_description,
                    quadrant_reason=(
                        item.reasoning_summary
                        or _default_quadrant_reason(item.origin_quadrant)
                    ),
                    proposed_by=proposer,
                )
            if item.confirmation_status is None:
                # Legacy epistemic_status is evidence maturity, not an auditable
                # confirmation. Old records must be reviewed instead of silently
                # inheriting "confirmed".
                item.confirmation_status = 'pending'
            _validate_confirmation_state(
                item.confirmation_status,
                item.confirmation_basis,
            )
            item.epistemic_status = _legacy_epistemic_status(
                item.confirmation_status,
                item.origin_quadrant,
            )
        return self

    @model_validator(mode="after")
    def reject_credentials(self) -> "StructuredEpisode":
        reject_credentials(self, 'Structured episode')
        return self

    @model_validator(mode='after')
    def validate_graph_references(self):
        entity_keys = [entity.key for entity in self.entities]
        if len(entity_keys) != len(set(entity_keys)):
            raise ValueError('entity keys must be unique within an episode')
        relationship_keys = [relationship.key for relationship in self.relationships]
        if len(relationship_keys) != len(set(relationship_keys)):
            raise ValueError('relationship keys must be unique within an episode')
        available = set(entity_keys)
        superseded_keys: list[str] = []
        for relationship in self.relationships:
            if relationship.source not in available or relationship.target not in available:
                raise ValueError('relationship source and target must reference episode entities')
            if relationship.invalid_at and relationship.supersedes:
                raise ValueError('an invalid relationship cannot replace existing knowledge')
            superseded_keys.extend(relationship.supersedes)
        if len(superseded_keys) != len(set(superseded_keys)):
            raise ValueError(
                'one existing relationship cannot have multiple replacements in an episode'
            )
        return self


class PublicationDraftCreate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    target_project_id: str = Field(min_length=1, max_length=128)
    provider_url: str = Field(min_length=8, max_length=2048)
    episode: StructuredEpisode

    @field_validator('provider_url')
    @classmethod
    def validate_provider_url(cls, value: str) -> str:
        return normalize_provider_url(value)

    @model_validator(mode='after')
    def require_public_eligible_episode(self):
        require_public_eligible_episode(self.episode)
        return self


class PublicationDraftRecord(StrictModel):
    id: str
    personal_space_id: str
    target_project_id: str
    provider_url: str
    status: Literal['pending', 'submitting', 'submission_unknown', 'submitted', 'kept_personal', 'ignored', 'source_deleted']
    episode: StructuredEpisode | None
    source_identity: dict[str, str] = Field(default_factory=dict)
    payload_scrubbed_by: str | None = None
    payload_scrubbed_at: datetime | None = None
    created_at: datetime
    decided_at: datetime | None = None
    shared_proposal_id: str | None = None
    submission_id: str | None = None
    submission_started_at: datetime | None = None
    submission_unknown_at: datetime | None = None
    submission_unknown_reason: Literal['ttl', 'remote_error'] | None = None
    last_submission_error: dict[str, str] | None = None
    submission_outcome: Literal['unknown'] | None = None


class PublicationDraftDecision(StrictModel):
    decision: Literal['submit_public', 'keep_personal', 'ignore']
    shared_proposal_id: str | None = Field(default=None, max_length=128)

    @model_validator(mode='after')
    def require_shared_proposal(self):
        if self.decision == 'submit_public' and not self.shared_proposal_id:
            raise ValueError('shared_proposal_id is required after public submission')
        if self.decision != 'submit_public' and self.shared_proposal_id:
            raise ValueError('shared_proposal_id is only valid for public submission')
        return self
class KnowledgeCommit(StrictModel):
    space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    project_agent_id: str | None = Field(default=None, min_length=1, max_length=128)
    # Saved in a temporary session project because nobody chose its scope yet
    # (rec#20); separate from the content's own confirmation status.
    scope_status: Literal['undetermined'] | None = None
    episode: StructuredEpisode

    @model_validator(mode='after')
    def validate_project_agent_scope(self):
        if self.project_agent_id and not self.personal_project_id:
            raise ValueError('project Agent knowledge requires personal_project_id')
        return self


class CommitResult(StrictModel):
    status: Literal['committed', 'duplicate']
    space_id: str
    episode_id: str
    entity_ids: list[str]
    relationship_ids: list[str]


class ProposalCreate(StrictModel):
    episode: StructuredEpisode

    @model_validator(mode='after')
    def require_public_eligible_episode(self):
        require_public_eligible_episode(self.episode)
        return self


class ProposalRecord(StrictModel):
    id: str
    project_id: str
    submitted_by: str
    status: Literal['pending', 'processing', 'approved', 'rejected']
    episode: StructuredEpisode
    created_at: datetime
    decided_at: datetime | None = None
    decided_by: str | None = None
    decision_note: str | None = None


class ProposalDecision(StrictModel):
    decision: Literal['approve', 'reject']
    note: str | None = Field(default=None, max_length=2000)


class SearchRequest(StrictModel):
    space_ids: list[str] = Field(min_length=1, max_length=32)
    query: str = Field(min_length=1, max_length=2048)
    limit: int = Field(default=12, ge=1, le=100)
    include_historical: bool = False
    include_pending: bool = Field(
        default=False,
        validation_alias=AliasChoices('include_pending', 'include_exploratory'),
    )
    personal_project_ids: list[str] = Field(default_factory=list, max_length=16)
    active_personal_project_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
    )
    project_agent_id: str | None = Field(default=None, min_length=1, max_length=128)
    inherit_project_knowledge: bool = True
    include_personal_global: bool = False

    @field_validator('personal_project_ids')
    @classmethod
    def validate_personal_project_ids(cls, value: list[str]) -> list[str]:
        normalized = [item.strip() for item in value]
        if any(not item or len(item) > 128 for item in normalized):
            raise ValueError('personal project ids must contain 1 to 128 characters')
        if len(set(normalized)) != len(normalized):
            raise ValueError('personal project ids must be unique')
        return normalized

    @model_validator(mode='after')
    def validate_active_personal_project(self):
        if (
            self.active_personal_project_id
            and self.active_personal_project_id not in self.personal_project_ids
        ):
            raise ValueError(
                'active personal project id must be present in personal project ids'
            )
        if self.project_agent_id and not self.active_personal_project_id:
            raise ValueError('project Agent search requires active_personal_project_id')
        return self


class EntitySearchResult(KnowledgeWeightView):
    id: str
    space_id: str
    group_id: str
    name: str
    type: str
    summary: str
    created_at: datetime | None = None
    origin_quadrant: EpistemicQuadrant = 'known_known'
    current_quadrant: EpistemicQuadrant = 'known_known'
    epistemic_status: EpistemicStatus = 'confirmed'
    confirmation_status: ConfirmationStatus = 'pending'
    confirmation_basis: ConfirmationBasis | None = None
    reasoning_summary: str | None = None
    profile_aspect: PersonalProfileAspect | None = None
    preference_scope: ScopedPreferenceScope | None = None
    preference_project_id: str | None = None
    preference_agent_id: str | None = None
    key: str | None = None
    preference_key: str | None = None
    preference_qualifiers: dict[str, Any] = Field(default_factory=dict)
    defined_project_id: str | None = None
    project_agent_id: str | None = None
    inheritance_mode: KnowledgeInheritanceMode = 'local_only'
    inherited_project_ids: list[str] = Field(default_factory=list, max_length=32)
    human_edited: bool = False
    human_change_status: HumanChangeStatus = 'none'
    human_change_version: int = Field(default=0, ge=0)
    last_human_changed_at: datetime | None = None
    last_agent_viewed_at: datetime | None = None
    last_agent_reviewed_at: datetime | None = None
    utility_score: float = Field(default=0, ge=0, le=1)
    confidence_score: float = Field(default=0.5, ge=0, le=1)
    qualified_use_count: int = Field(default=0, ge=0)
    distinct_task_count: int = Field(default=0, ge=0)
    last_used_at: datetime | None = None
    negative_evidence_count: int = Field(default=0, ge=0)
    requires_attention: bool = False
    last_feedback_kind: KnowledgeFeedbackKind | None = None
    last_feedback_at: datetime | None = None
    scope_distance: int = Field(default=0, ge=0, le=8)
    inherited_from_project_id: str | None = None
    scope_path: list[str] = Field(default_factory=list, max_length=9)
    source_uris: list[str] = Field(default_factory=list, max_length=20)
    score: float | None = None


class FactResult(KnowledgeWeightView):
    id: str
    space_id: str
    group_id: str
    source_entity: str
    target_entity: str
    relationship: str
    fact: str
    valid_at: datetime | None
    invalid_at: datetime | None
    created_at: datetime
    episodes: list[str]
    origin_quadrant: EpistemicQuadrant = 'known_known'
    current_quadrant: EpistemicQuadrant = 'known_known'
    epistemic_status: EpistemicStatus = 'confirmed'
    confirmation_status: ConfirmationStatus = 'pending'
    confirmation_basis: ConfirmationBasis | None = None
    reasoning_summary: str | None = None
    profile_aspect: PersonalProfileAspect | None = None
    preference_scope: ScopedPreferenceScope | None = None
    preference_project_id: str | None = None
    preference_agent_id: str | None = None
    key: str | None = None
    preference_key: str | None = None
    preference_qualifiers: dict[str, Any] = Field(default_factory=dict)
    defined_project_id: str | None = None
    project_agent_id: str | None = None
    inheritance_mode: KnowledgeInheritanceMode = 'local_only'
    inherited_project_ids: list[str] = Field(default_factory=list, max_length=32)
    human_edited: bool = False
    human_change_status: HumanChangeStatus = 'none'
    human_change_version: int = Field(default=0, ge=0)
    last_human_changed_at: datetime | None = None
    last_agent_viewed_at: datetime | None = None
    last_agent_reviewed_at: datetime | None = None
    utility_score: float = Field(default=0, ge=0, le=1)
    confidence_score: float = Field(default=0.5, ge=0, le=1)
    qualified_use_count: int = Field(default=0, ge=0)
    distinct_task_count: int = Field(default=0, ge=0)
    last_used_at: datetime | None = None
    negative_evidence_count: int = Field(default=0, ge=0)
    requires_attention: bool = False
    last_feedback_kind: KnowledgeFeedbackKind | None = None
    last_feedback_at: datetime | None = None
    scope_distance: int = Field(default=0, ge=0, le=8)
    inherited_from_project_id: str | None = None
    scope_path: list[str] = Field(default_factory=list, max_length=9)
    source_uris: list[str] = Field(default_factory=list, max_length=20)
    score: float | None = None


class SearchResult(StrictModel):
    facts: list[FactResult]
    entities: list[EntitySearchResult] = Field(default_factory=list)


class CollaborationPreferenceItem(KnowledgeWeightView):
    id: str
    item_kind: KnowledgeItemKind
    key: str
    preference_key: str
    title: str
    instruction: str
    profile_aspect: PersonalProfileAspect
    preference_scope: ScopedPreferenceScope
    preference_project_id: str | None = None
    preference_agent_id: str | None = None
    attributes: dict[str, Any] = Field(default_factory=dict)
    preference_qualifiers: dict[str, Any] = Field(default_factory=dict)
    weight: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    reason: str | None = None
    confirmation_basis: ConfirmationBasis
    reasoning_summary: str | None = None
    inheritance_mode: KnowledgeInheritanceMode = 'local_only'
    inherited_project_ids: list[str] = Field(default_factory=list, max_length=32)
    confirmation_status: Literal['confirmed', 'agent_confirmed']
    confirmed_at: datetime
    created_at: datetime | None = None
    scope_distance: int = Field(default=0, ge=0, le=2)
    inherited_from_project_id: str | None = None
    scope_path: list[str] = Field(default_factory=list, max_length=3)


class CollaborationPreferenceConflict(StrictModel):
    preference_key: str
    preference_scope: ScopedPreferenceScope
    preference_project_id: str | None = None
    preference_agent_id: str | None = None
    item_ids: list[str] = Field(min_length=2)


class CollaborationSourceWindows(StrictModel):
    candidates_truncated: bool
    project_ancestors_truncated: bool
    queued_conflicts_truncated: bool


class CollaborationContextResult(StrictModel):
    personal_space_id: str
    personal_project_id: str | None = None
    project_agent_id: str | None = None
    global_preferences: list[CollaborationPreferenceItem] = Field(default_factory=list)
    project_preferences: list[CollaborationPreferenceItem] = Field(default_factory=list)
    agent_preferences: list[CollaborationPreferenceItem] = Field(default_factory=list)
    effective_preferences: list[CollaborationPreferenceItem] = Field(default_factory=list)
    task_scope_excluded_count: int = Field(default=0, ge=0)
    task_scope_filtered: bool = False
    # Keys of preferences limited to a task dimension the request did not state.
    scope_unknown: list[str] = Field(default_factory=list)
    conflicts: list[CollaborationPreferenceConflict] = Field(default_factory=list)
    queued_conflicts: list['PreferenceConflictRecord'] = Field(default_factory=list)
    source_windows: CollaborationSourceWindows | None = None
    overridden_global_ids: list[str] = Field(default_factory=list)
    overridden_inherited_ids: list[str] = Field(default_factory=list)
    overridden_project_ids: list[str] = Field(default_factory=list)
    overridden_lower_authority_ids: list[str] = Field(default_factory=list)
    truncated: bool = False


class AgentReaderRef(StrictModel):
    """The Agent reading: an FLA in its project, or neither for a plain
    session. The person's console names no reader; it proves itself with the
    human-review channel instead (knowledge_visibility)."""
    reader_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    reader_agent_id: str | None = Field(default=None, min_length=1, max_length=128)


# A conflict's write names its reader too: one naming an item this reader may
# not see answers as missing, before anything is written or returned (0.20.1).
class PreferenceConflictDeferCreate(AgentReaderRef):
    personal_space_id: str = Field(min_length=1, max_length=128)
    conflict_id: str = Field(min_length=1, max_length=1024)
    preference_key: str = Field(min_length=1, max_length=512)
    preference_scope: PreferenceScope
    preference_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    left_item_id: str = Field(min_length=1, max_length=256)
    left_item_kind: KnowledgeItemKind
    right_item_id: str = Field(min_length=1, max_length=256)
    right_item_kind: KnowledgeItemKind
    reason: str = Field(min_length=1, max_length=2000)
    operation_actor: KnowledgeOperationActor = 'human'

    @model_validator(mode='after')
    def validate_conflict(self):
        if (
            self.left_item_id == self.right_item_id
            and self.left_item_kind == self.right_item_kind
        ):
            raise ValueError('preference conflict requires two different items')
        if self.preference_scope == 'project' and not self.preference_project_id:
            raise ValueError('project preference conflict requires preference_project_id')
        if self.preference_scope == 'global' and self.preference_project_id:
            raise ValueError('global preference conflict cannot set preference_project_id')
        return self


class PreferenceConflictResolveCreate(AgentReaderRef):
    personal_space_id: str = Field(min_length=1, max_length=128)
    resolution: PreferenceConflictResolutionAction
    reason: str = Field(min_length=1, max_length=2000)
    canonical_item_id: str | None = Field(default=None, min_length=1, max_length=256)
    merged_instruction: str | None = Field(default=None, min_length=1, max_length=4096)
    split_item_id: str | None = Field(default=None, min_length=1, max_length=256)
    split_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    operation_actor: KnowledgeOperationActor = 'agent'

    @model_validator(mode='after')
    def validate_resolution_details(self):
        if self.resolution == 'merge':
            if not self.canonical_item_id or not self.merged_instruction:
                raise ValueError(
                    'merge requires canonical_item_id and merged_instruction'
                )
        if self.resolution == 'split_scope':
            if not self.split_item_id or not self.split_project_id:
                raise ValueError('split_scope requires split_item_id and split_project_id')
        return self


class PreferenceConflictCompleteCreate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    resolution: PreferenceConflictResolutionAction
    reason: str = Field(min_length=1, max_length=2000)
    operation_actor: KnowledgeOperationActor = 'human'


class PreferenceConflictRecord(StrictModel):
    id: str
    personal_space_id: str
    preference_key: str
    preference_scope: PreferenceScope
    preference_project_id: str | None = None
    left_item_id: str
    left_item_kind: KnowledgeItemKind
    right_item_id: str
    right_item_kind: KnowledgeItemKind
    status: PreferenceConflictQueueStatus
    requested_by: KnowledgeOperationActor
    resolution: PreferenceConflictResolutionAction | None = None
    resolved_by: KnowledgeOperationActor | None = None
    reason: str
    resolution_reason: str | None = None
    deferred_at: datetime
    resolved_at: datetime | None = None
    updated_at: datetime


class GraphEvidence(StrictModel):
    id: str
    name: str
    source_description: str
    source_kind: str
    source_uri: str | None = Field(default=None, min_length=1, max_length=2048)
    summary: str
    session_id: str | None = None
    source_application: SourceApplication | None = None
    source_turn_id: str | None = None
    source_excerpt: str | None = None
    personal_project_id: str | None = None
    reference_time: datetime | None = None
    created_at: datetime | None = None

    @field_validator('source_uri')
    @classmethod
    def validate_source_uri(cls, value: str | None) -> str | None:
        return _validated_source_uri(value) if value is not None else None


class KnowledgeRevisionCreate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    item_kind: KnowledgeItemKind
    action: KnowledgeContentRevisionAction
    reason: str = Field(min_length=1, max_length=2000)
    name: str | None = Field(default=None, min_length=1, max_length=512)
    summary: str | None = Field(default=None, max_length=4096)
    fact: str | None = Field(default=None, min_length=1, max_length=8192)
    origin_quadrant: EpistemicQuadrant | None = None
    current_quadrant: EpistemicQuadrant | None = None
    epistemic_status: EpistemicStatus | None = None
    confirmation_status: ConfirmationStatus | None = None
    confirmation_basis: ConfirmationBasis | None = None
    reasoning_summary: str | None = Field(default=None, max_length=4096)
    profile_aspect: PersonalProfileAspect | Literal['none'] | None = None
    inheritance_mode: KnowledgeInheritanceMode | None = None
    inherited_project_ids: list[str] | None = Field(default=None, max_length=32)
    replacement_item_id: str | None = Field(default=None, min_length=1, max_length=256)
    replacement_item_kind: KnowledgeItemKind | None = None
    operation_actor: KnowledgeOperationActor = 'agent'
    # The version the editor read; another current version is a conflict.
    expected_version: int | None = Field(default=None, ge=0)
    basis_meaning: BasisMeaning | None = None

    @model_validator(mode='after')
    def validate_update_fields(self):
        has_replacement_id = self.replacement_item_id is not None
        has_replacement_kind = self.replacement_item_kind is not None
        if has_replacement_id != has_replacement_kind:
            raise ValueError(
                'replacement item id and kind must be provided together'
            )
        if self.action == 'link_replacement' and not has_replacement_id:
            raise ValueError('linking a replacement requires a replacement item')
        if (
            self.action not in {'invalidate', 'link_replacement'}
            and has_replacement_id
        ):
            raise ValueError(
                'replacement item is only valid when invalidating or linking a replacement'
            )
        if self.action == 'confirm':
            if (
                self.confirmation_status != 'confirmed'
                or self.confirmation_basis is None
            ):
                raise ValueError(
                    'confirmation requires confirmed status and a structured basis'
                )
            if any(value is not None for value in (
                self.name,
                self.summary,
                self.fact,
                self.origin_quadrant,
                self.current_quadrant,
                self.epistemic_status,
                self.reasoning_summary,
                self.profile_aspect,
                self.inheritance_mode,
                self.inherited_project_ids,
            )):
                raise ValueError('confirmation cannot change knowledge content or taxonomy')
        if self.action in ('reaffirm', 'mark_meaning_changed') and self.operation_actor != 'human':
            raise ValueError('only a person reviews what a changed basis means')
        if self.basis_meaning is not None and self.action not in ('update', 'confirm'):
            raise ValueError('basis_meaning belongs to an edit or a confirmation')
        if self.basis_meaning == 'wording_only' and self.operation_actor != 'human':
            raise ValueError('only a person can say an edit changed the wording alone')
        if self.action in ('mark_outdated', 'reaffirm', 'mark_meaning_changed') and any(value is not None for value in (
            self.name, self.summary, self.fact, self.origin_quadrant, self.current_quadrant,
            self.epistemic_status, self.confirmation_status, self.confirmation_basis,
            self.reasoning_summary, self.profile_aspect, self.inheritance_mode,
            self.inherited_project_ids,
        )):
            raise ValueError(f'{self.action} keeps the content; re-assert it as a new version')
        if self.action == 'update':
            taxonomy_changed = any(value is not None for value in (
                self.current_quadrant,
                self.epistemic_status,
                self.origin_quadrant,
                self.confirmation_status,
                self.confirmation_basis,
                self.reasoning_summary,
                self.profile_aspect,
                self.inheritance_mode,
                self.inherited_project_ids,
            ))
            if (
                self.item_kind == 'entity'
                and self.name is None
                and self.summary is None
                and not taxonomy_changed
            ):
                raise ValueError('entity update requires content or epistemic metadata')
            if self.item_kind == 'relationship' and self.fact is None and not taxonomy_changed:
                raise ValueError('relationship update requires content or epistemic metadata')
        if self.confirmation_status is not None:
            if self.confirmation_status == 'agent_confirmed':
                raise ValueError(
                    'agent-confirmed status can only be produced by the '
                    'knowledge usage policy'
                )
            if self.confirmation_basis is None:
                raise ValueError('confirmation status requires a structured confirmation basis')
            _validate_confirmation_state(
                self.confirmation_status,
                self.confirmation_basis,
            )
        if (self.inheritance_mode is None) != (self.inherited_project_ids is None):
            raise ValueError(
                'inheritance mode and inherited project ids must be updated together'
            )
        if self.inheritance_mode is not None:
            _validate_inheritance(
                self.inheritance_mode,
                self.inherited_project_ids,
                None if self.profile_aspect in {None, 'none'} else self.profile_aspect,
            )
        reject_credentials(self, 'Knowledge revision')
        return self


class KnowledgeBatchConfirmationItem(StrictModel):
    item_id: str = Field(min_length=1, max_length=256)
    item_kind: KnowledgeItemKind
    existence_reason: str = Field(min_length=1, max_length=4096)
    quadrant_reason: str = Field(min_length=1, max_length=4096)
    proposed_by: ConfirmationActor


class KnowledgeBatchConfirmationCreate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    group_kind: KnowledgeConfirmationGroupKind
    group_value: str = Field(min_length=1, max_length=256)
    reason: str = Field(min_length=1, max_length=2000)
    confirmer: ConfirmationActor
    items: list[KnowledgeBatchConfirmationItem] = Field(
        min_length=2,
        max_length=200,
    )
    operation_actor: KnowledgeOperationActor = 'agent'

    @model_validator(mode='after')
    def validate_batch_confirmation(self):
        if self.confirmer.kind not in {'user', 'authoritative_source'}:
            raise ValueError('an agent or import cannot confirm knowledge')
        if self.confirmer.kind == 'authoritative_source' and not self.confirmer.label:
            raise ValueError('an authoritative source confirmer requires a label')
        identities = {
            (item.item_kind, item.item_id)
            for item in self.items
        }
        if len(identities) != len(self.items):
            raise ValueError('batch confirmation items must be unique')
        reject_credentials(self, 'Knowledge batch confirmation')
        return self


class KnowledgeBatchConfirmationResult(StrictModel):
    group_kind: KnowledgeConfirmationGroupKind
    group_value: str
    confirmed_count: int = Field(ge=0, le=200)
    confirmed_at: datetime
    item_keys: list[str] = Field(max_length=200)
