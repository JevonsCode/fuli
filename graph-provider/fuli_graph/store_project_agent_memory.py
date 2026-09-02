"""Versioned working notes; one graph-backed head per space/project/Agent.

The property-dependent SET acquires Neo4j's write lock before checking the
revision. This protects against concurrent hosts, not just one Python process.
"""

import hashlib
import json

from fastapi import HTTPException

from .project_agent_access import authorize_project_agent
from .project_agent_memory_models import (
    ProjectAgentMemoryRecord,
    ProjectAgentMemoryView,
    ProjectAgentMemoryWrite,
)
from .provider_values import now_utc, stable_uuid


class StoreProjectAgentMemory:
    async def get_project_agent_memory(
        self, actor, personal_space_id, personal_project_id, agent_id, *, limit=1,
    ) -> ProjectAgentMemoryView:
        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'reader')
        await authorize_project_agent(
            self, actor, space, personal_project_id, agent_id, require_memory=True,
        )
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (head:FuliProjectAgentMemory {id: $memory_id})-
                  [:HAS_MEMORY_CHECKPOINT]->(checkpoint:FuliProjectAgentMemoryCheckpoint)
            RETURN checkpoint.record_json AS record_json
            ORDER BY checkpoint.revision DESC LIMIT $limit
            ''',
            memory_id=self._agent_memory_id(
                personal_space_id, personal_project_id, agent_id,
            ),
            limit=max(1, min(limit, 10)),
            routing_='r',
        )
        history = [
            ProjectAgentMemoryRecord.model_validate_json(row['record_json'])
            for row in records
        ]
        current = history[0] if history else None
        return ProjectAgentMemoryView(
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            agent_id=agent_id,
            revision=current.revision if current else 0,
            current=current,
            history=history,
        )

    async def write_project_agent_memory(
        self, actor, request: ProjectAgentMemoryWrite,
    ) -> ProjectAgentMemoryRecord:
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        agent = await authorize_project_agent(
            self, actor, space, request.personal_project_id, request.agent_id,
            require_active=True, require_memory=True,
        )
        allowed_clients = json.loads(agent['profile_json']).get('allowed_clients', [])
        if request.source_application not in allowed_clients:
            raise HTTPException(status_code=403, detail='Agent is not allowed in this client')
        if request.task_id:
            task_rows, _, _ = await self.runtime.driver.execute_query(
                '''
                MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
                      [:HAS_PROJECT_AGENT_TASK]->(task:FuliProjectAgentTask {
                        task_id: $task_id, personal_project_id: $project_id
                      })-[:HAS_PARTICIPANT]->(agent:FuliProjectAgent {agent_id: $agent_id})
                MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(agent)
                RETURN task.task_id AS task_id
                ''',
                space_id=request.personal_space_id,
                project_id=request.personal_project_id,
                agent_id=request.agent_id,
                task_id=request.task_id,
                routing_='r',
            )
            if not task_rows:
                raise HTTPException(status_code=404, detail='Agent memory task not found')
        memory_id = self._agent_memory_id(
            request.personal_space_id, request.personal_project_id, request.agent_id,
        )
        checkpoint_id = stable_uuid(memory_id, request.idempotency_key)
        payload = request.model_dump(mode='json', exclude={
            'source_application', 'source_session_id',
        })
        payload_hash = hashlib.sha256(json.dumps(
            payload, sort_keys=True, ensure_ascii=False, separators=(',', ':'),
        ).encode()).hexdigest()
        checkpoint = ProjectAgentMemoryRecord(
            checkpoint_id=checkpoint_id,
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            agent_id=request.agent_id,
            revision=request.expected_revision + 1,
            memory=request.memory,
            source_application=request.source_application,
            source_session_id=request.source_session_id,
            task_id=request.task_id,
            created_at=now_utc(),
        )
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent {
                    agent_id: $agent_id, status: 'active'
                  })
            MATCH (space)-[:CONTAINS_PROJECT]->
                  (project:FuliPersonalProject {project_id: $project_id})-
                  [:HAS_PROJECT_AGENT_ASSIGNMENT]->
                  (:FuliProjectAgentAssignment {status: 'active'})-[:ASSIGNED_AGENT]->(agent)
            WHERE coalesce(agent.memory_scope, 'reviewed_agent') <> 'task_only'
            WITH DISTINCT space, project, agent
            MERGE (head:FuliProjectAgentMemory {id: $memory_id})
            ON CREATE SET head.revision = 0,
                          head.personal_space_id = $space_id,
                          head.personal_project_id = $project_id,
                          head.agent_id = $agent_id
            SET head.write_serial = coalesce(head.write_serial, 0) + 1
            MERGE (agent)-[:HAS_WORKING_MEMORY]->(head)
            MERGE (project)-[:HAS_AGENT_WORKING_MEMORY]->(head)
            WITH head
            OPTIONAL MATCH (head)-[:HAS_MEMORY_CHECKPOINT]->
                  (existing:FuliProjectAgentMemoryCheckpoint {id: $checkpoint_id})
            WITH head, existing,
                 existing IS NULL AND head.revision = $expected_revision AS can_write
            FOREACH (ignored IN CASE WHEN can_write THEN [1] ELSE [] END |
              CREATE (checkpoint:FuliProjectAgentMemoryCheckpoint {
                id: $checkpoint_id, revision: $revision,
                payload_hash: $payload_hash, record_json: $record_json
              })
              CREATE (head)-[:HAS_MEMORY_CHECKPOINT]->(checkpoint)
              SET head.revision = $revision, head.updated_at = $created_at
            )
            WITH head
            OPTIONAL MATCH (head)-[:HAS_MEMORY_CHECKPOINT]->
                  (saved:FuliProjectAgentMemoryCheckpoint {id: $checkpoint_id})
            RETURN saved.record_json AS record_json, saved.payload_hash AS payload_hash,
                   head.revision AS current_revision
            ''',
            space_id=request.personal_space_id,
            project_id=request.personal_project_id,
            agent_id=request.agent_id,
            memory_id=memory_id,
            checkpoint_id=checkpoint_id,
            expected_revision=request.expected_revision,
            revision=checkpoint.revision,
            payload_hash=payload_hash,
            record_json=checkpoint.model_dump_json(),
            created_at=checkpoint.created_at,
        )
        if not records:
            raise HTTPException(status_code=409, detail='Agent assignment is no longer active')
        row = records[0]
        if not row.get('record_json'):
            raise HTTPException(
                status_code=409,
                detail='Agent memory changed; reload its latest revision before merging notes',
            )
        if row['payload_hash'] != payload_hash:
            raise HTTPException(status_code=409, detail='memory idempotency key has different input')
        return ProjectAgentMemoryRecord.model_validate_json(row['record_json'])

    def _agent_memory_id(self, space_id, project_id, agent_id):
        return stable_uuid(
            self.settings.provider_id, space_id, project_id, agent_id, 'working-memory',
        )
