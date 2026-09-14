from typing import Annotated, Any

from fastapi import Query

from .project_agent_attention_models import (
    AgentAttentionCreate, AgentAttentionDecision, AgentAttentionList,
    AgentAttentionRecord, AttentionStatus,
)


def register_project_agent_attention_routes(application, store, Actor: Any):
    @application.post('/v1/agent-attention', response_model=AgentAttentionRecord)
    async def create(request: AgentAttentionCreate, actor: Actor):
        return await store.create_agent_attention(actor, request)

    @application.get('/v1/agent-attention', response_model=AgentAttentionList)
    async def list_requests(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
        personal_project_id: Annotated[str | None, Query(min_length=1, max_length=128)] = None,
        agent_id: Annotated[str | None, Query(min_length=1, max_length=128)] = None,
        status: AttentionStatus | None = 'open',
        limit: Annotated[int, Query(ge=1, le=200)] = 100,
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        return await store.list_agent_attention(
            actor, personal_space_id, personal_project_id, agent_id, status, limit, offset,
        )

    @application.post('/v1/agent-attention/cancel', response_model=AgentAttentionRecord)
    async def cancel(request: AgentAttentionDecision, actor: Actor):
        return await store.decide_agent_attention(actor, request, human=False)

    @application.post('/v1/agent-attention/respond', response_model=AgentAttentionRecord)
    async def respond(request: AgentAttentionDecision, actor: Actor):
        # Only the trusted local-user HTTP workflow exposes this operation.
        # A reply does not execute an approval, permission change or acceptance.
        return await store.decide_agent_attention(actor, request, human=True)
