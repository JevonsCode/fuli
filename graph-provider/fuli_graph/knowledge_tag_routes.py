"""HTTP routes of the open tag vocabulary. Reads are POST queries like the other
Provider queries; every write names its actor and reason. A write claimed as
the person's own needs the human-review proof (ReviewAwareActor), and the
person's governance (approve, merge, split, retire, relations, undo) is applied
only on the human-review channel (HumanReviewer): an Agent can preview it,
never apply it (rec#11 D-07 part 2, D-22)."""

from typing import Any

from .knowledge_tag_governance import apply_governance, preview_governance
from .knowledge_tag_governance_models import (
    KnowledgeTagDetail,
    KnowledgeTagDetailQuery,
    KnowledgeTagGovernanceApply,
    KnowledgeTagGovernancePreview,
    KnowledgeTagGovernanceRequest,
    KnowledgeTagGovernanceResult,
    KnowledgeTagVocabulary,
    KnowledgeTagVocabularyQuery,
)
from .knowledge_tag_models import (
    KnowledgeTagAliasCreate,
    KnowledgeTagAliasResult,
    KnowledgeTagCreate,
    KnowledgeTagCreateResult,
    KnowledgeTagLinkChange,
    KnowledgeTagLinkResult,
    KnowledgeTagMetrics,
    KnowledgeTagMetricsQuery,
    KnowledgeTagResolve,
    KnowledgeTagResolveResult,
)
from .knowledge_tag_vocabulary import list_vocabulary, read_tag_detail
from .knowledge_tags import add_tag_alias, attach_tag, create_tag, detach_tag, resolve_tags, tag_metrics


def register_knowledge_tag_routes(application, store, Actor: Any, ReviewAwareActor: Any,
                                  HumanReviewer: Any) -> None:
    @application.post('/v1/knowledge-tags/resolve', response_model=KnowledgeTagResolveResult)
    async def resolve(request: KnowledgeTagResolve, actor: Actor):
        return await resolve_tags(store, actor, request)

    @application.post('/v1/knowledge-tags/create', response_model=KnowledgeTagCreateResult)
    async def create(request: KnowledgeTagCreate, actor: ReviewAwareActor):
        return await create_tag(store, actor, request)

    @application.post('/v1/knowledge-tags/aliases', response_model=KnowledgeTagAliasResult)
    async def alias(request: KnowledgeTagAliasCreate, actor: ReviewAwareActor):
        return await add_tag_alias(store, actor, request)

    @application.post('/v1/knowledge-tags/attach', response_model=KnowledgeTagLinkResult)
    async def attach(request: KnowledgeTagLinkChange, actor: ReviewAwareActor):
        return await attach_tag(store, actor, request)

    @application.post('/v1/knowledge-tags/detach', response_model=KnowledgeTagLinkResult)
    async def detach(request: KnowledgeTagLinkChange, actor: ReviewAwareActor):
        return await detach_tag(store, actor, request)

    @application.post('/v1/knowledge-tags/metrics', response_model=KnowledgeTagMetrics)
    async def metrics(request: KnowledgeTagMetricsQuery, actor: Actor):
        return await tag_metrics(store, actor, request)

    @application.post('/v1/knowledge-tags/vocabulary', response_model=KnowledgeTagVocabulary)
    async def vocabulary(request: KnowledgeTagVocabularyQuery, actor: Actor):
        return await list_vocabulary(store, actor, request)

    @application.post('/v1/knowledge-tags/detail', response_model=KnowledgeTagDetail)
    async def detail(request: KnowledgeTagDetailQuery, actor: Actor):
        return await read_tag_detail(store, actor, request)

    @application.post('/v1/knowledge-tags/governance/preview', response_model=KnowledgeTagGovernancePreview)
    async def governance_preview(request: KnowledgeTagGovernanceRequest, actor: Actor):
        return await preview_governance(store, actor, request)

    @application.post('/v1/knowledge-tags/governance/apply', response_model=KnowledgeTagGovernanceResult)
    async def governance_apply(request: KnowledgeTagGovernanceApply, actor: HumanReviewer):
        return await apply_governance(store, actor, request)
