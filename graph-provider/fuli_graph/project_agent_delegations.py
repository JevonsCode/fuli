"""Short-lived, session-bound capabilities for a real roundtable invocation."""

from hashlib import sha256
from secrets import token_urlsafe

from fastapi import HTTPException
from pydantic import Field

from .models import SourceApplication, StrictModel
from .personal_project_access import authorize_personal_project


class AgentDelegationIssue(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    task_context_token: str = Field(min_length=1, max_length=256)
    source_application: SourceApplication
    agent_id: str = Field(min_length=1, max_length=128)
    target_application: SourceApplication
    target_session_id: str | None = Field(default=None, min_length=1, max_length=256)
    lifetime_seconds: int = Field(default=300, ge=30, le=900)


class AgentDelegationCheck(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    token: str = Field(min_length=32, max_length=128)
    session_id: str | None = Field(default=None, min_length=1, max_length=256)


def token_hash(token):
    return sha256(token.encode()).hexdigest()


class StoreAgentDelegations:
    async def issue_agent_delegation(self, actor, request):
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        context = await self.get_task_context(actor, request.personal_space_id,
                                             request.task_context_token, request.source_application)
        project_id = context.get('personal_project_id')
        if not project_id or (context.get('checkpoint') or {}).get('phase') == 'complete':
            raise HTTPException(409, 'Delegation requires an active project task')
        await authorize_personal_project(self, actor, space, project_id)
        policy = await self.get_project_agent_coordination_policy(actor, request.personal_space_id, project_id)
        lead = policy.team_lead_agent_id
        sender = context.get('project_agent_id')
        if not lead or not sender or (sender != lead and request.agent_id != lead):
            raise HTTPException(403, 'Members must communicate through the project lead')
        target = await self.get_project_agent(actor, request.personal_space_id, project_id, request.agent_id)
        if (target.profile.status != 'active'
                or request.target_application not in target.profile.allowed_clients):
            raise HTTPException(403, 'The receiving Agent is unavailable in this client')
        token = token_urlsafe(32)
        # Only hashes are stored. A crash leaves a bounded lifetime, never a
        # reusable authority derived from a public message or thread identifier.
        await self.runtime.driver.execute_query(
            '''MATCH (old:FuliAgentDelegation {space_id: $space_id})
               WHERE old.expires_at <= datetime() DELETE old''', space_id=request.personal_space_id)
        await self.runtime.driver.execute_query(
            '''CREATE (:FuliAgentDelegation {token_hash: $token_hash, space_id: $space_id,
                 project_id: $project_id, agent_id: $agent_id, source_application: $application,
                 session_id: $session_id, sender_token: $sender_token, lead_agent_id: $lead,
                 expires_at: datetime() + duration({seconds: $lifetime}), redeemed: false})''',
            token_hash=token_hash(token), space_id=request.personal_space_id, project_id=project_id,
            agent_id=request.agent_id, application=request.target_application,
            session_id=request.target_session_id, sender_token=request.task_context_token,
            lead=lead, lifetime=request.lifetime_seconds)
        return {'token': token}

    async def redeem_agent_delegation(self, request, lead):
        if not request.delegation_token or not request.delegation_session_id or not request.agent_id:
            return False
        # Lock before reading the session binding: two different sessions cannot
        # both claim a fresh capability. Same-session hook/MCP retries are safe.
        rows, _, _ = await self.runtime.driver.execute_query(
            '''MATCH (:FuliSpace {id: $space_id})-[:CONTAINS_PROJECT]->
                  (:FuliPersonalProject {project_id: $project_id})-
                  [:HAS_PROJECT_AGENT_COORDINATION_POLICY]->(policy:FuliProjectAgentCoordinationPolicy)
               SET policy._fuli_write_lock = true
               REMOVE policy._fuli_write_lock
               WITH policy WHERE policy.team_lead_agent_id = $lead
               MATCH (grant:FuliAgentDelegation {token_hash: $token_hash, space_id: $space_id,
                  project_id: $project_id, agent_id: $agent_id, source_application: $application,
                  lead_agent_id: $lead})
               SET grant.write_serial = coalesce(grant.write_serial, 0) + 1
               WITH grant
               WHERE grant.expires_at > datetime()
                 AND (grant.session_id IS NULL OR grant.session_id = $session_id)
               MATCH (session:FuliTaskContextSession)-[:HAS_CONTEXT]->(task:FuliTaskContext)
               WHERE task.token = grant.sender_token AND session.current_token = task.token
                 AND NOT task.completed AND task.personal_space_id = grant.space_id
                 AND task.personal_project_id = grant.project_id
                 AND (task.project_agent_id = grant.lead_agent_id OR grant.agent_id = grant.lead_agent_id)
               SET grant.session_id = $session_id, grant.redeemed = true
               RETURN grant.token_hash AS token_hash''',
            token_hash=token_hash(request.delegation_token), space_id=request.personal_space_id,
            project_id=request.personal_project_id, agent_id=request.agent_id,
            application=request.source_application, lead=lead, session_id=request.delegation_session_id)
        return bool(rows)

    async def verify_agent_delegation(self, actor, request):
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'reader')
        rows, _, _ = await self.runtime.driver.execute_query(
            '''MATCH (grant:FuliAgentDelegation {token_hash: $token_hash, space_id: $space_id,
                  session_id: $session_id, redeemed: true})
               WHERE grant.expires_at > datetime()
               RETURN grant.token_hash AS token_hash''',
            token_hash=token_hash(request.token), space_id=request.personal_space_id,
            session_id=request.session_id)
        return {'redeemed': bool(rows)}

    async def revoke_agent_delegation(self, actor, request):
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        await self.runtime.driver.execute_query(
            '''MATCH (grant:FuliAgentDelegation {token_hash: $token_hash, space_id: $space_id})
               DELETE grant''', token_hash=token_hash(request.token), space_id=request.personal_space_id)
        return {'revoked': True}
