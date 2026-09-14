import hashlib
import json

from fastapi import HTTPException

from .personal_project_access import authorize_personal_project
from .project_agent_access import authorize_project_agent
from .project_agent_attention_models import (
    AgentAttentionCreate, AgentAttentionDecision, AgentAttentionList,
    AgentAttentionRecord,
)
from .provider_values import native_datetime, now_utc, stable_uuid
from .system_hr_identity import resolve_hr_alias


class StoreProjectAgentAttention:
    """Explicit human requests; never infer attention from worker/task status."""

    async def create_agent_attention(self, actor, request: AgentAttentionCreate):
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        agent_id = await resolve_hr_alias(self, request.personal_space_id, request.agent_id)
        await authorize_project_agent(
            self, actor, space, request.personal_project_id, agent_id,
            require_active=True,
            allow_unassigned=agent_id in {
                'employee.bole', 'employee.jefa', 'fuli-project-coordinator',
            },
        )
        if request.task_id:
            task = await self._find_task_row(
                request.personal_space_id, request.task_id,
                request.personal_project_id,
            )
            if not task:
                raise HTTPException(status_code=404, detail='project Agent task not found')
        payload = request.model_dump(exclude={'idempotency_key'})
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        payload['agent_id'] = agent_id
        request_id = stable_uuid(
            self.settings.provider_id, request.personal_space_id,
            request.personal_project_id, 'agent-attention', request.idempotency_key,
        )
        timestamp = now_utc()
        rows, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})
            MERGE (request:FuliAgentAttention {id: $request_id})
            ON CREATE SET request += $payload,
                          request.request_id = $request_id,
                          request.fingerprint = $fingerprint,
                          request.status = 'open', request.revision = 0,
                          request.created_at = $timestamp,
                          request.updated_at = $timestamp
            MERGE (space)-[:HAS_AGENT_ATTENTION]->(request)
            RETURN request
            ''',
            personal_space_id=request.personal_space_id, request_id=request_id,
            payload=payload, fingerprint=fingerprint, timestamp=timestamp,
        )
        raw = dict(rows[0]['request'])
        if raw['fingerprint'] != fingerprint:
            raise HTTPException(status_code=409, detail='attention idempotency key conflict')
        return attention_record(raw)

    async def list_agent_attention(
        self, actor, personal_space_id, personal_project_id=None,
        agent_id=None, status='open', limit=100, offset=0,
    ):
        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'reader')
        agent_id = await resolve_hr_alias(self, personal_space_id, agent_id)
        if personal_project_id:
            await authorize_personal_project(self, actor, space, personal_project_id)
        rows, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
                  [:HAS_AGENT_ATTENTION]->(request:FuliAgentAttention)
            WHERE ($project_id IS NULL OR request.personal_project_id = $project_id)
              AND ($agent_id IS NULL OR request.agent_id = $agent_id)
              AND ($status IS NULL OR request.status = $status)
            WITH request ORDER BY request.created_at DESC, request.request_id
            WITH collect(request) AS requests
            RETURN requests[$offset..($offset + $limit)] AS items,
                   size(requests) AS total,
                   [r IN requests WHERE r.status = 'open' | r.agent_id] AS open_agents
            ''', space_id=personal_space_id, project_id=personal_project_id,
            agent_id=agent_id, status=status, limit=limit, offset=offset, routing_='r',
        )
        row = rows[0] if rows else {'items': [], 'total': 0, 'open_agents': []}
        counts = {}
        for agent in row['open_agents']:
            counts[agent] = counts.get(agent, 0) + 1
        return AgentAttentionList(
            items=[attention_record(dict(item)) for item in row['items']],
            total=row['total'], counts=counts,
        )

    async def decide_agent_attention(
        self, actor, request: AgentAttentionDecision, *, human: bool,
    ):
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        await authorize_personal_project(self, actor, space, request.personal_project_id)
        timestamp = now_utc()
        # Increment obtains a write lock before the revision predicate is checked.
        # A stale caller cannot overwrite the response recorded by another client.
        rows, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
                  [:HAS_AGENT_ATTENTION]->(request:FuliAgentAttention {
                    request_id: $request_id, personal_project_id: $project_id
                  })
            SET request.lock_version = coalesce(request.lock_version, 0) + 1
            WITH request
            WHERE request.revision = $revision AND request.status = 'open'
            SET request.status = $status, request.response = $response,
                request.responded_by = $responded_by,
                request.revision = request.revision + 1,
                request.updated_at = $timestamp
            RETURN request
            ''', space_id=request.personal_space_id,
            project_id=request.personal_project_id, request_id=request.request_id,
            revision=request.expected_revision, response=request.response,
            status='resolved' if human else 'cancelled',
            responded_by='human' if human else 'agent', timestamp=timestamp,
        )
        if not rows:
            raise HTTPException(status_code=409, detail='attention changed or is no longer open; reload it')
        return attention_record(dict(rows[0]['request']))


def attention_record(raw):
    return AgentAttentionRecord(**{
        key: native_datetime(raw.get(key)) if key in {'created_at', 'updated_at'} else raw.get(key)
        for key in AgentAttentionRecord.model_fields
        if key in raw
    })
