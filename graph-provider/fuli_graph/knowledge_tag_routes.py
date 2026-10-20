"""HTTP routes of the open tag vocabulary. Reads are POST queries like the other
Provider queries; every write names its actor and reason."""

from typing import Any

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
from .knowledge_tags import add_tag_alias, attach_tag, create_tag, detach_tag, resolve_tags, tag_metrics


def register_knowledge_tag_routes(application, store, Actor: Any) -> None:
    @application.post('/v1/knowledge-tags/resolve', response_model=KnowledgeTagResolveResult)
    async def resolve(request: KnowledgeTagResolve, actor: Actor):
        return await resolve_tags(store, actor, request)

    @application.post('/v1/knowledge-tags/create', response_model=KnowledgeTagCreateResult)
    async def create(request: KnowledgeTagCreate, actor: Actor):
        return await create_tag(store, actor, request)

    @application.post('/v1/knowledge-tags/aliases', response_model=KnowledgeTagAliasResult)
    async def alias(request: KnowledgeTagAliasCreate, actor: Actor):
        return await add_tag_alias(store, actor, request)

    @application.post('/v1/knowledge-tags/attach', response_model=KnowledgeTagLinkResult)
    async def attach(request: KnowledgeTagLinkChange, actor: Actor):
        return await attach_tag(store, actor, request)

    @application.post('/v1/knowledge-tags/detach', response_model=KnowledgeTagLinkResult)
    async def detach(request: KnowledgeTagLinkChange, actor: Actor):
        return await detach_tag(store, actor, request)

    @application.post('/v1/knowledge-tags/metrics', response_model=KnowledgeTagMetrics)
    async def metrics(request: KnowledgeTagMetricsQuery, actor: Actor):
        return await tag_metrics(store, actor, request)
