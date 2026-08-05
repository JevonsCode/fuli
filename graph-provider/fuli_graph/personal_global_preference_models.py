from datetime import datetime
from typing import Any, Literal

from pydantic import Field, model_validator

from .models import (
    ConfirmationBasis,
    ConfirmationStatus,
    KnowledgeItemKind,
    PersonalProfileAspect,
    StrictModel,
)

PersonalGlobalPreferenceTargetScope = Literal[
    'parent_project',
    'personal_global',
]


class PersonalGlobalPreferenceSourceRef(StrictModel):
    item_id: str = Field(min_length=1, max_length=256)
    item_kind: KnowledgeItemKind
    project_id: str = Field(min_length=1, max_length=128)


class PersonalGlobalPreferenceSourceSnapshot(
    PersonalGlobalPreferenceSourceRef
):
    key: str = Field(min_length=1, max_length=256)
    preference_key: str = Field(min_length=1, max_length=512)
    preference_qualifiers: dict[str, Any] = Field(default_factory=dict)
    title: str = Field(min_length=1, max_length=512)
    instruction: str = Field(max_length=8192)
    profile_aspect: PersonalProfileAspect
    confirmation_status: Literal['confirmed', 'agent_confirmed']
    confirmation_basis: ConfirmationBasis
    human_change_version: int = Field(default=0, ge=0)
    usage_generation: int = Field(default=1, ge=1)
    last_human_changed_at: datetime | None = None
    negative_evidence_count: int = Field(default=0, ge=0)
    requires_attention: bool = False
    last_feedback_at: datetime | None = None
    source_uris: list[str] = Field(default_factory=list, max_length=20)
    stored_confirmation_basis_json: str = Field(
        default='{}',
        exclude=True,
        repr=False,
    )
    stored_attributes_json: str = Field(default='{}', exclude=True, repr=False)


class PersonalGlobalPreferenceEligibleTargetScope(StrictModel):
    target_scope: PersonalGlobalPreferenceTargetScope
    target_project_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
    )
    max_distance: int | None = Field(default=None, ge=1, le=2)

    @model_validator(mode='after')
    def validate_target(self):
        if self.target_scope == 'parent_project' and not self.target_project_id:
            raise ValueError('parent_project target requires target_project_id')
        if self.target_scope == 'personal_global' and self.target_project_id:
            raise ValueError('personal_global target cannot set target_project_id')
        return self


class PersonalGlobalPreferenceScopeOptionsRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    source_items: list[PersonalGlobalPreferenceSourceRef] = Field(
        min_length=2,
        max_length=32,
    )
    preference_key: str = Field(min_length=1, max_length=512)


class PersonalGlobalPreferenceScopeOptions(StrictModel):
    personal_space_id: str
    candidate_id: str
    candidate_version: str
    preference_key: str
    source_snapshots: list[PersonalGlobalPreferenceSourceSnapshot]
    eligible_target_scopes: list[PersonalGlobalPreferenceEligibleTargetScope]


class PersonalGlobalPreferenceDecisionIntent(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    candidate_version: str = Field(pattern=r'^v1:[a-f0-9]{24}$')
    decision_revision: int = Field(ge=0)
    source_items: list[PersonalGlobalPreferenceSourceRef] = Field(
        min_length=2,
        max_length=32,
    )
    preference_key: str = Field(min_length=1, max_length=512)
    target_scope: PersonalGlobalPreferenceTargetScope
    target_project_id: str | None = Field(
        min_length=1,
        max_length=128,
    )
    decision: Literal['approve', 'reject']
    global_title: str | None = Field(default=None, min_length=1, max_length=512)
    global_instruction: str | None = Field(
        default=None,
        min_length=1,
        max_length=8192,
    )
    profile_aspect: PersonalProfileAspect | None = None
    human_confirmation_reason: str = Field(min_length=1, max_length=4096)
    confirmed_at: datetime
    session_id: str = Field(min_length=1, max_length=256)
    idempotency_key: str = Field(min_length=8, max_length=256)

    @model_validator(mode='after')
    def validate_decision(self):
        item_keys = {
            (item.item_kind, item.item_id)
            for item in self.source_items
        }
        project_ids = {item.project_id for item in self.source_items}
        if len(item_keys) != len(self.source_items):
            raise ValueError('source preference items must be unique')
        if len(project_ids) != len(self.source_items):
            raise ValueError(
                'source preferences must come from distinct projects'
            )
        if self.target_scope == 'parent_project' and not self.target_project_id:
            raise ValueError('parent_project target requires target_project_id')
        if self.target_scope == 'personal_global' and self.target_project_id:
            raise ValueError('personal_global target cannot set target_project_id')
        if self.decision == 'approve':
            if not (
                self.global_title
                and self.global_instruction
                and self.profile_aspect
            ):
                raise ValueError(
                    'approve requires a complete global preference assertion'
                )
        elif any((
            self.global_title,
            self.global_instruction,
            self.profile_aspect,
        )):
            raise ValueError(
                'reject cannot include a global preference assertion'
            )
        return self


class PersonalGlobalPreferenceDecisionApply(
    PersonalGlobalPreferenceDecisionIntent
):
    approval_token: str = Field(min_length=32, max_length=512)


class PersonalGlobalPreferenceDecisionInspection(StrictModel):
    status: Literal['human_review_required']
    personal_space_id: str
    candidate_id: str
    candidate_version: str
    decision_revision: int = Field(ge=0)
    decision: Literal['approve', 'reject']
    preference_key: str
    target_scope: PersonalGlobalPreferenceTargetScope
    target_project_id: str | None = None
    eligible_target_scopes: list[PersonalGlobalPreferenceEligibleTargetScope]
    payload_fingerprint: str
    source_snapshots: list[PersonalGlobalPreferenceSourceSnapshot]
    candidate_binding_verified: bool = True
    original_sources_will_remain_unchanged: bool = True
    scope_apply_performed: bool = False
    approval_token_issued: bool = False
    required_action: str


class PersonalGlobalPreferenceDecisionPreview(StrictModel):
    preview_id: str
    candidate_id: str
    candidate_version: str
    decision_revision: int = Field(ge=0)
    target_scope: PersonalGlobalPreferenceTargetScope
    target_project_id: str | None = None
    eligible_target_scopes: list[PersonalGlobalPreferenceEligibleTargetScope]
    payload_fingerprint: str
    approval_token: str
    expires_at: datetime
    source_snapshots: list[PersonalGlobalPreferenceSourceSnapshot]
    candidate_binding_verified: bool = True
    original_sources_will_remain_unchanged: bool = True
    scope_apply_performed: bool = False


class PersonalGlobalPreferenceCandidateVersionRef(StrictModel):
    candidate_id: str = Field(
        pattern=r'^personal-global-[a-f0-9]{20}$',
    )
    candidate_version: str = Field(pattern=r'^v1:[a-f0-9]{24}$')


class PersonalGlobalPreferenceDecisionStatusRequest(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    candidates: list[PersonalGlobalPreferenceCandidateVersionRef] = Field(
        min_length=1,
        max_length=100,
    )


class PersonalGlobalPreferenceDecisionRecord(StrictModel):
    decision_event_id: str
    candidate_id: str
    candidate_version: str
    decision_revision: int = Field(ge=1)
    decision: Literal['approved', 'rejected']
    target_scope: PersonalGlobalPreferenceTargetScope
    target_project_id: str | None = None
    global_assertion_id: str | None = None
    global_assertion_active: bool
    decision_sequence: int = Field(ge=1)
    decided_at: datetime
    human_confirmation_reason: str


class PersonalGlobalPreferenceDecisionRevision(StrictModel):
    candidate_id: str
    decision_revision: int = Field(ge=0)
    current_candidate_version: str | None = None


class PersonalGlobalPreferenceDecisionStatusResult(StrictModel):
    personal_space_id: str
    decisions: list[PersonalGlobalPreferenceDecisionRecord]
    revisions: list[PersonalGlobalPreferenceDecisionRevision]
