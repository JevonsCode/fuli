from .staffing_demand import StaffingDemandQuery, query_staffing_demand
from .agent_verification_models import AgentQualityQuery, AgentVerification
from .agent_loan_models import AgentLoanRequest, AgentLoanDecision, AgentLoanQuery
from .agent_conversation_models import (
    ConversationQuery, ConversationWrite, ConversationResume, ConversationPolicyWrite,
)
from .conversation_triage_models import (
    ConversationTriageWrite, ConversationTopicQuery, ConversationTopicFormation, ConversationTopicDecline,
)


def register_agent_conversation_routes(application, store, Actor):
    @application.post('/v1/occupation-demand/query')
    async def staffing_demand(request: StaffingDemandQuery, actor: Actor):
        return await query_staffing_demand(store, actor, request)

    @application.post('/v1/agent-verification/query')
    async def quality(request: AgentQualityQuery, actor: Actor):
        return await store.query_agent_quality(actor, request)

    @application.post('/v1/agent-verification/record')
    async def verify(request: AgentVerification, actor: Actor):
        return await store.record_agent_verification(actor, request)

    @application.post('/v1/agent-loans/query')
    async def loans(request: AgentLoanQuery, actor: Actor):
        return await store.list_agent_loans(actor, request)

    @application.post('/v1/agent-loans/request')
    async def request_loan(request: AgentLoanRequest, actor: Actor):
        return await store.request_agent_loan(actor, request)

    @application.post('/v1/agent-loans/decide')
    async def decide_loan(request: AgentLoanDecision, actor: Actor):
        return await store.decide_agent_loan(actor, request)

    @application.post('/v1/agent-conversations/query')
    async def query(request: ConversationQuery, actor: Actor):
        return await store.query_conversations(actor, request)

    @application.post('/v1/agent-conversations/boundary')
    async def boundary(request: ConversationWrite, actor: Actor):
        return await store.claim_conversation_boundary(actor, request)

    @application.post('/v1/agent-conversations/append')
    async def append(request: ConversationWrite, actor: Actor):
        return await store.append_conversation(actor, request)

    @application.post('/v1/agent-conversations/resume')
    async def resume(request: ConversationResume, actor: Actor):
        return await store.resume_conversation(actor, request)

    @application.put('/v1/agent-conversations/policy')
    async def policy(request: ConversationPolicyWrite, actor: Actor):
        return await store.write_conversation_policy(actor, request)

    @application.post('/v1/conversation-triage/record')
    async def triage(request: ConversationTriageWrite, actor: Actor):
        return await store.record_conversation_triage(actor, request)

    @application.post('/v1/conversation-triage/topics')
    async def topics(request: ConversationTopicQuery, actor: Actor):
        return await store.query_conversation_topics(actor, request)

    @application.post('/v1/conversation-triage/decline')
    async def decline(request: ConversationTopicDecline, actor: Actor):
        return await store.decline_conversation_topic(actor, request)

    @application.post('/v1/conversation-triage/form')
    async def form(request: ConversationTopicFormation, actor: Actor):
        return await store.form_conversation_topic(actor, request)
