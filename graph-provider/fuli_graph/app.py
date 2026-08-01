from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Header, Query

from .auth import matches_bootstrap_token
from .config import Settings, get_settings
from .graph_models import GraphResult
from .knowledge_usage_models import KnowledgeUsageCreate, KnowledgeUsageResult
from .knowledge_feedback_models import (
    KnowledgeFeedbackCreate,
    KnowledgeFeedbackResult,
)
from .knowledge_review_models import (
    KnowledgeReviewCandidatePage,
    KnowledgeReviewCandidateRequest,
    KnowledgeReviewDecision,
    KnowledgeReviewFinish,
    KnowledgeReviewProgress,
    KnowledgeReviewRun,
    KnowledgeReviewStart,
)
from .common_knowledge_models import (
    CommonKnowledgePromotionPreview,
    CommonKnowledgePromotionRequest,
    CommonKnowledgePromotionResult,
)
from .project_action_models import (
    KnowledgeProjectActionRequest,
    KnowledgeProjectActionResult,
    KnowledgeProjectPreviewRecord,
    KnowledgeProjectPreviewRequest,
)
from .models import (
    BootstrapRequest,
    BootstrapResult,
    CollaborationContextResult,
    CommitResult,
    KnowledgeAgentReviewCreate,
    KnowledgeAgentViewCreate,
    KnowledgeAgentViewResult,
    KnowledgeAuditRecord,
    KnowledgeCommit,
    KnowledgeAssignmentChange,
    KnowledgeAssignmentRecord,
    KnowledgeBatchConfirmationCreate,
    KnowledgeBatchConfirmationResult,
    PreferenceScopeChange,
    PreferenceConflictCompleteCreate,
    PreferenceConflictDeferCreate,
    PreferenceConflictRecord,
    PreferenceConflictResolveCreate,
    KnowledgeRevisionCreate,
    KnowledgeRevisionRecord,
    KnowledgeHumanChangeSearchRequest,
    KnowledgeHumanChangeSearchResult,
    MembershipCreate,
    MembershipRecord,
    PersonalProjectRecord,
    PersonalProjectUpsert,
    PrincipalCreate,
    PrincipalResult,
    ProjectRelationCreate,
    ProjectRelationDecision,
    ProjectRelationRecord,
    ProjectDeleteResult,
    ProjectReleaseRecord,
    PublicationDraftCreate,
    PublicationDraftDecision,
    PublicationDraftRecord,
    ProposalCreate,
    ProposalDecision,
    ProposalRecord,
    SearchRequest,
    SearchResult,
    SpaceCreate,
    SpaceRecord,
    SubscriptionCreate,
    SubscriptionDeleteResult,
    SubscriptionRecord,
)
from .knowledge_audit import (
    record_agent_views,
    record_knowledge_feedback,
    record_knowledge_usage,
    review_human_change,
    search_human_changes,
)
from .knowledge_batch_confirmation import confirm_knowledge_batch
from .knowledge_review import (
    finish_knowledge_review,
    list_knowledge_review_candidates,
    record_knowledge_review_progress,
    start_knowledge_review,
)
from .common_knowledge import (
    apply_common_knowledge_promotion,
    preview_common_knowledge_promotion,
)
from .knowledge_management import (
    reassign_knowledge_item,
    revise_knowledge_item,
    set_preference_scope,
)
from .project_knowledge import (
    apply_knowledge_project_action,
    preview_knowledge_project_action,
)
from .preference_conflicts import (
    complete_preference_conflict,
    defer_preference_conflict,
    list_preference_conflicts,
    resolve_preference_conflict,
)
from .runtime import GraphitiRuntime
from .store import GraphStore


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or get_settings()
    runtime = GraphitiRuntime(resolved_settings)
    store = GraphStore(runtime, resolved_settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await runtime.initialize()
        yield
        await runtime.close()

    application = FastAPI(
        title='Fuli Graph Provider',
        version='0.2.0',
        lifespan=lifespan,
    )
    application.state.store = store
    application.state.settings = resolved_settings

    async def current_actor(
        authorization: Annotated[str | None, Header()] = None,
    ) -> dict:
        prefix = 'Bearer '
        if not authorization or not authorization.startswith(prefix):
            from fastapi import HTTPException

            raise HTTPException(status_code=401, detail='bearer access token required')
        return await store.authenticate(authorization[len(prefix) :])

    Actor = Annotated[dict, Depends(current_actor)]

    @application.get('/health')
    async def health() -> dict:
        return await store.health()

    @application.post('/v1/bootstrap', response_model=BootstrapResult)
    async def bootstrap(
        request: BootstrapRequest,
        x_fuli_bootstrap_token: Annotated[str | None, Header()] = None,
    ) -> BootstrapResult:
        if not matches_bootstrap_token(
            x_fuli_bootstrap_token,
            resolved_settings.bootstrap_token,
        ):
            from fastapi import HTTPException

            raise HTTPException(status_code=401, detail='invalid bootstrap token')
        principal_id, access_token = await store.bootstrap(request.principal_name)
        return BootstrapResult(principal_id=principal_id, access_token=access_token)

    @application.post('/v1/principals', response_model=PrincipalResult)
    async def create_principal(request: PrincipalCreate, actor: Actor) -> PrincipalResult:
        return await store.create_principal(actor, request.name)

    @application.post('/v1/spaces', response_model=SpaceRecord)
    async def create_space(request: SpaceCreate, actor: Actor) -> SpaceRecord:
        return await store.create_space(actor, request)

    @application.get('/v1/spaces', response_model=list[SpaceRecord])
    async def list_spaces(actor: Actor) -> list[SpaceRecord]:
        return await store.list_spaces(actor)

    @application.get(
        '/v1/projects/{project_id}/releases',
        response_model=list[ProjectReleaseRecord],
    )
    async def list_project_releases(
        project_id: str,
        actor: Actor,
    ) -> list[ProjectReleaseRecord]:
        return await store.list_project_releases(actor, project_id)

    @application.delete(
        '/v1/projects/{project_id}',
        response_model=ProjectDeleteResult,
    )
    async def delete_project(
        project_id: str,
        actor: Actor,
    ) -> ProjectDeleteResult:
        return await store.delete_project(actor, project_id)

    @application.put('/v1/personal-projects', response_model=PersonalProjectRecord)
    async def upsert_personal_project(
        request: PersonalProjectUpsert,
        actor: Actor,
    ) -> PersonalProjectRecord:
        return await store.upsert_personal_project(actor, request)

    @application.get('/v1/personal-projects', response_model=list[PersonalProjectRecord])
    async def list_personal_projects(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
    ) -> list[PersonalProjectRecord]:
        return await store.list_personal_projects(actor, personal_space_id)

    @application.get(
        '/v1/personal-projects/{project_id}',
        response_model=PersonalProjectRecord,
    )
    async def get_personal_project(
        project_id: str,
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
    ) -> PersonalProjectRecord:
        return await store.get_personal_project(actor, personal_space_id, project_id)

    @application.post('/v1/publication-drafts', response_model=PublicationDraftRecord)
    async def create_publication_draft(
        request: PublicationDraftCreate,
        actor: Actor,
    ) -> PublicationDraftRecord:
        return await store.create_publication_draft(actor, request)

    @application.get('/v1/publication-drafts', response_model=list[PublicationDraftRecord])
    async def list_publication_drafts(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        draft_status: Annotated[str, Query(alias='status')] = 'pending',
    ) -> list[PublicationDraftRecord]:
        return await store.list_publication_drafts(actor, personal_space_id, draft_status)

    @application.get(
        '/v1/publication-drafts/{draft_id}',
        response_model=PublicationDraftRecord,
    )
    async def get_publication_draft(
        draft_id: str,
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
    ) -> PublicationDraftRecord:
        return await store.get_publication_draft(actor, personal_space_id, draft_id)

    @application.post(
        '/v1/publication-drafts/{draft_id}/decision',
        response_model=PublicationDraftRecord,
    )
    async def decide_publication_draft(
        draft_id: str,
        request: PublicationDraftDecision,
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
    ) -> PublicationDraftRecord:
        return await store.decide_publication_draft(
            actor,
            personal_space_id,
            draft_id,
            request,
        )

    @application.post(
        '/v1/projects/{project_id}/members',
        response_model=MembershipRecord,
    )
    async def add_member(
        project_id: str,
        request: MembershipCreate,
        actor: Actor,
    ) -> MembershipRecord:
        return await store.add_membership(actor, project_id, request)

    @application.post(
        '/v1/projects/{project_id}/relations',
        response_model=ProjectRelationRecord,
    )
    async def create_project_relation(
        project_id: str,
        request: ProjectRelationCreate,
        actor: Actor,
    ) -> ProjectRelationRecord:
        return await store.create_project_relation(actor, project_id, request)

    @application.get(
        '/v1/projects/{project_id}/relations',
        response_model=list[ProjectRelationRecord],
    )
    async def list_project_relations(
        project_id: str,
        actor: Actor,
    ) -> list[ProjectRelationRecord]:
        return await store.list_project_relations(actor, project_id)

    @application.post(
        '/v1/projects/{project_id}/relations/{relation_id}/decision',
        response_model=ProjectRelationRecord,
    )
    async def decide_project_relation(
        project_id: str,
        relation_id: str,
        request: ProjectRelationDecision,
        actor: Actor,
    ) -> ProjectRelationRecord:
        return await store.decide_project_relation(actor, project_id, relation_id, request)

    @application.post('/v1/subscriptions', response_model=SubscriptionRecord)
    async def subscribe(request: SubscriptionCreate, actor: Actor) -> SubscriptionRecord:
        return await store.subscribe(actor, request)

    @application.get('/v1/subscriptions', response_model=list[SubscriptionRecord])
    async def list_subscriptions(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
    ) -> list[SubscriptionRecord]:
        return await store.list_subscriptions(actor, personal_space_id)

    @application.delete(
        '/v1/subscriptions/{project_id}',
        response_model=SubscriptionDeleteResult,
    )
    async def unsubscribe(
        project_id: str,
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        provider_url: Annotated[str, Query(min_length=8, max_length=2048)],
    ) -> SubscriptionDeleteResult:
        return await store.unsubscribe(actor, personal_space_id, project_id, provider_url)

    @application.post('/v1/knowledge/commits', response_model=CommitResult)
    async def commit_personal(request: KnowledgeCommit, actor: Actor) -> CommitResult:
        return await store.commit_personal(actor, request)

    @application.post(
        '/v1/knowledge/reviews/start',
        response_model=KnowledgeReviewRun,
    )
    async def start_review(
        request: KnowledgeReviewStart,
        actor: Actor,
    ) -> KnowledgeReviewRun:
        return await start_knowledge_review(store, actor, request)

    @application.post(
        '/v1/knowledge/reviews/candidates',
        response_model=KnowledgeReviewCandidatePage,
    )
    async def review_candidates(
        request: KnowledgeReviewCandidateRequest,
        actor: Actor,
    ) -> KnowledgeReviewCandidatePage:
        return await list_knowledge_review_candidates(store, actor, request)

    @application.post(
        '/v1/knowledge/reviews/progress',
        response_model=KnowledgeReviewDecision,
    )
    async def record_review_progress(
        request: KnowledgeReviewProgress,
        actor: Actor,
    ) -> KnowledgeReviewDecision:
        return await record_knowledge_review_progress(store, actor, request)

    @application.post(
        '/v1/knowledge/reviews/finish',
        response_model=KnowledgeReviewRun,
    )
    async def finish_review(
        request: KnowledgeReviewFinish,
        actor: Actor,
    ) -> KnowledgeReviewRun:
        return await finish_knowledge_review(store, actor, request)

    @application.patch(
        '/v1/knowledge/items/{item_id}',
        response_model=KnowledgeRevisionRecord,
    )
    async def revise_item(
        item_id: str,
        request: KnowledgeRevisionCreate,
        actor: Actor,
    ) -> KnowledgeRevisionRecord:
        return await revise_knowledge_item(store, actor, item_id, request)

    @application.post(
        '/v1/knowledge/agent-views',
        response_model=KnowledgeAgentViewResult,
    )
    async def record_agent_knowledge_views(
        request: KnowledgeAgentViewCreate,
        actor: Actor,
    ) -> KnowledgeAgentViewResult:
        return await record_agent_views(store, actor, request)

    @application.post(
        '/v1/knowledge/usage',
        response_model=KnowledgeUsageResult,
    )
    async def record_agent_knowledge_usage(
        request: KnowledgeUsageCreate,
        actor: Actor,
    ) -> KnowledgeUsageResult:
        return await record_knowledge_usage(store, actor, request)

    @application.post(
        '/v1/knowledge/feedback',
        response_model=KnowledgeFeedbackResult,
    )
    async def record_negative_knowledge_evidence(
        request: KnowledgeFeedbackCreate,
        actor: Actor,
    ) -> KnowledgeFeedbackResult:
        return await record_knowledge_feedback(store, actor, request)

    @application.post(
        '/v1/knowledge/items/{item_id}/agent-review',
        response_model=KnowledgeAuditRecord,
    )
    async def review_human_knowledge_change(
        item_id: str,
        request: KnowledgeAgentReviewCreate,
        actor: Actor,
    ) -> KnowledgeAuditRecord:
        return await review_human_change(store, actor, item_id, request)

    @application.post(
        '/v1/knowledge/human-changes/search',
        response_model=KnowledgeHumanChangeSearchResult,
    )
    async def search_human_knowledge_changes(
        request: KnowledgeHumanChangeSearchRequest,
        actor: Actor,
    ) -> KnowledgeHumanChangeSearchResult:
        return await search_human_changes(store, actor, request)

    @application.post(
        '/v1/knowledge/batch-confirmations',
        response_model=KnowledgeBatchConfirmationResult,
    )
    async def confirm_batch(
        request: KnowledgeBatchConfirmationCreate,
        actor: Actor,
    ) -> KnowledgeBatchConfirmationResult:
        return await confirm_knowledge_batch(store, actor, request)

    @application.post(
        '/v1/knowledge/items/{item_id}/assignment',
        response_model=KnowledgeAssignmentRecord,
    )
    async def reassign_item(
        item_id: str,
        request: KnowledgeAssignmentChange,
        actor: Actor,
    ) -> KnowledgeAssignmentRecord:
        return await reassign_knowledge_item(store, actor, item_id, request)

    @application.post(
        '/v1/knowledge/items/{item_id}/preference-scope',
        response_model=KnowledgeRevisionRecord,
    )
    async def change_preference_scope(
        item_id: str,
        request: PreferenceScopeChange,
        actor: Actor,
    ) -> KnowledgeRevisionRecord:
        return await set_preference_scope(store, actor, item_id, request)

    @application.post(
        '/v1/knowledge/common-promotions/preview',
        response_model=CommonKnowledgePromotionPreview,
    )
    async def preview_common_promotion(
        request: CommonKnowledgePromotionRequest,
        actor: Actor,
    ) -> CommonKnowledgePromotionPreview:
        return await preview_common_knowledge_promotion(
            store, actor, request
        )

    @application.post(
        '/v1/knowledge/common-promotions',
        response_model=CommonKnowledgePromotionResult,
    )
    async def apply_common_promotion(
        request: CommonKnowledgePromotionRequest,
        actor: Actor,
    ) -> CommonKnowledgePromotionResult:
        return await apply_common_knowledge_promotion(
            store, actor, request
        )

    @application.post(
        '/v1/preference-conflicts/defer',
        response_model=PreferenceConflictRecord,
    )
    async def defer_conflict(
        request: PreferenceConflictDeferCreate,
        actor: Actor,
    ) -> PreferenceConflictRecord:
        return await defer_preference_conflict(store, actor, request)

    @application.get(
        '/v1/preference-conflicts',
        response_model=list[PreferenceConflictRecord],
    )
    async def preference_conflicts(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        status: Annotated[str | None, Query(pattern='^(ai_pending|resolved)$')] = None,
        limit: Annotated[int, Query(ge=1, le=1000)] = 500,
    ) -> list[PreferenceConflictRecord]:
        return await list_preference_conflicts(
            store,
            actor,
            personal_space_id,
            status=status,
            limit=limit,
        )

    @application.post(
        '/v1/preference-conflicts/{conflict_id}/resolve',
        response_model=PreferenceConflictRecord,
    )
    async def resolve_conflict(
        conflict_id: str,
        request: PreferenceConflictResolveCreate,
        actor: Actor,
    ) -> PreferenceConflictRecord:
        return await resolve_preference_conflict(
            store,
            actor,
            conflict_id,
            request,
        )

    @application.post(
        '/v1/preference-conflicts/{conflict_id}/complete',
        response_model=PreferenceConflictRecord,
    )
    async def complete_conflict(
        conflict_id: str,
        request: PreferenceConflictCompleteCreate,
        actor: Actor,
    ) -> PreferenceConflictRecord:
        return await complete_preference_conflict(
            store,
            actor,
            conflict_id,
            request,
        )

    @application.post(
        '/v1/knowledge/items/{item_id}/project-action/preview',
        response_model=KnowledgeProjectPreviewRecord,
    )
    async def preview_project_action(
        item_id: str,
        request: KnowledgeProjectPreviewRequest,
        actor: Actor,
    ) -> KnowledgeProjectPreviewRecord:
        return await preview_knowledge_project_action(store, actor, item_id, request)

    @application.post(
        '/v1/knowledge/items/{item_id}/project-action',
        response_model=KnowledgeProjectActionResult,
    )
    async def apply_project_action(
        item_id: str,
        request: KnowledgeProjectActionRequest,
        actor: Actor,
    ) -> KnowledgeProjectActionResult:
        return await apply_knowledge_project_action(store, actor, item_id, request)

    @application.post(
        '/v1/projects/{project_id}/proposals',
        response_model=ProposalRecord,
    )
    async def create_proposal(
        project_id: str,
        request: ProposalCreate,
        actor: Actor,
    ) -> ProposalRecord:
        return await store.create_proposal(actor, project_id, request)

    @application.get(
        '/v1/projects/{project_id}/proposals',
        response_model=list[ProposalRecord],
    )
    async def list_proposals(
        project_id: str,
        actor: Actor,
        proposal_status: Annotated[str, Query(alias='status')] = 'pending',
    ) -> list[ProposalRecord]:
        return await store.list_proposals(actor, project_id, proposal_status)

    @application.post(
        '/v1/projects/{project_id}/proposals/{proposal_id}/decision',
        response_model=ProposalRecord,
    )
    async def decide_proposal(
        project_id: str,
        proposal_id: str,
        decision: ProposalDecision,
        actor: Actor,
    ) -> ProposalRecord:
        return await store.decide_proposal(actor, project_id, proposal_id, decision)

    @application.post('/v1/search', response_model=SearchResult)
    async def search(request: SearchRequest, actor: Actor) -> SearchResult:
        return await store.search(actor, request)

    @application.get(
        '/v1/collaboration-preferences',
        response_model=CollaborationContextResult,
    )
    async def collaboration_preferences(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        personal_project_id: Annotated[
            str | None,
            Query(min_length=1, max_length=128),
        ] = None,
        limit: Annotated[int, Query(ge=1, le=200)] = 100,
    ) -> CollaborationContextResult:
        return await store.collaboration_context(
            actor,
            personal_space_id,
            personal_project_id,
            limit,
        )

    @application.get('/v1/spaces/{space_id}/graph', response_model=GraphResult)
    async def graph(
        space_id: str,
        actor: Actor,
        limit: Annotated[int | None, Query(ge=1, le=2000)] = None,
        personal_project_id: Annotated[str | None, Query(min_length=1, max_length=128)] = None,
        offset: Annotated[int | None, Query(ge=0)] = None,
    ) -> GraphResult:
        return await store.graph(actor, space_id, limit, personal_project_id, offset)

    return application


app = create_app()
