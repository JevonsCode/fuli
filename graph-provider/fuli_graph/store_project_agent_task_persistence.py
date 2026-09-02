"""Recoverable participant and recruitment links for durable Agent tasks."""

import json
from fastapi import HTTPException


class StoreProjectAgentTaskPersistence:
    """Persist idempotent task edges and repair them on task replay."""

    async def _persist_task_links(
        self,
        request,
        *,
        transaction,
        task_id,
        participants,
        recruitment_links,
        status,
        created_at,
        updated_at=None,
        ended_at=None,
    ):
        # Canonical lock order avoids mirrored multi-Agent submissions taking
        # Agent node locks in opposite orders.
        for participant in sorted(
            participants,
            key=lambda item: item['agent_id'],
        ):
            result = await transaction.run(
                '''
                MATCH (space:FuliSpace {
                  id: $personal_space_id, kind: 'personal'
                })-[:HAS_PROJECT_AGENT_TASK]->
                      (task:FuliProjectAgentTask {task_id: $task_id})
                MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                      (agent:FuliProjectAgent {agent_id: $agent_id})
                // Share the Agent node lock with archive operations. If an
                // archive wins, the active-status guard makes this link fail;
                // if this write wins, archive observes the participant.
                SET agent._task_lifecycle_lock = true
                REMOVE agent._task_lifecycle_lock
                WITH task, agent
                WHERE agent.status = 'active'
                   OR $status IN ['completed', 'failed', 'cancelled']
                MERGE (task)-[participant:HAS_PARTICIPANT]->(agent)
                ON CREATE SET participant.role = $role,
                              participant.status = $status,
                              participant.assignment_summary =
                                $assignment_summary,
                              participant.joined_at = $created_at,
                              participant.updated_at = $updated_at,
                              participant.ended_at = $ended_at
                RETURN count(participant) AS linked_count
                ''',
                personal_space_id=request.personal_space_id,
                task_id=task_id,
                agent_id=participant['agent_id'],
                role=participant['role'],
                status=status,
                assignment_summary=participant.get('assignment_summary'),
                created_at=created_at,
                updated_at=updated_at or created_at,
                ended_at=ended_at,
            )
            await self._require_task_link(result)
        for linked in recruitment_links:
            result = await transaction.run(
                '''
                MATCH (space:FuliSpace {
                  id: $personal_space_id, kind: 'personal'
                })-[:HAS_PROJECT_AGENT_TASK]->
                      (task:FuliProjectAgentTask {task_id: $task_id})
                MATCH (space)-[:HAS_PROJECT_AGENT_RECRUITMENT]->
                      (recruitment:FuliProjectAgentRecruitment {
                        recruitment_id: $recruitment_id
                      })
                SET task.recruitment_id = CASE
                      WHEN $is_primary THEN $recruitment_id
                      ELSE task.recruitment_id END,
                    task.hr_agent_id = CASE
                      WHEN $is_primary THEN recruitment.hr_agent_id
                      ELSE task.hr_agent_id END
                MERGE (task)-[:TRIGGERED_RECRUITMENT]->(recruitment)
                RETURN count(recruitment) AS linked_count
                ''',
                personal_space_id=request.personal_space_id,
                task_id=task_id,
                recruitment_id=linked['recruitment_id'],
                is_primary=bool(linked.get('is_primary')),
            )
            await self._require_task_link(result)

    @staticmethod
    async def _require_task_link(result):
        records = [record async for record in result]
        if len(records) != 1 or records[0]['linked_count'] != 1:
            raise HTTPException(
                status_code=409,
                detail='task participant or recruitment target is unavailable',
            )

    async def _repair_task_persistence(self, request, raw_task):
        participant_plan = self._task_link_plan(
            raw_task.get('participant_plan_json')
        )
        recruitment_plan = self._task_link_plan(
            raw_task.get('recruitment_plan_json')
        )
        if not participant_plan and not recruitment_plan:
            return
        async with self.runtime.driver.transaction() as transaction:
            # Take the same task-node write lock used by activity transitions before
            # reading lifecycle state. The initial replay lookup may already be stale.
            result = await transaction.run(
                '''
                MATCH (space:FuliSpace {
                  id: $personal_space_id, kind: 'personal'
                })-[:HAS_PROJECT_AGENT_TASK]->
                      (task:FuliProjectAgentTask {task_id: $task_id})
                WHERE task.personal_project_id = $personal_project_id
                SET task.revision = coalesce(task.revision, 0)
                RETURN task
                ''',
                personal_space_id=request.personal_space_id,
                personal_project_id=request.personal_project_id,
                task_id=raw_task['task_id'],
            )
            records = [record async for record in result]
            if len(records) != 1:
                raise HTTPException(status_code=409, detail='task is unavailable for repair')
            current = dict(records[0]['task'])
            await self._persist_task_links(
                request,
                transaction=transaction,
                task_id=raw_task['task_id'],
                participants=participant_plan,
                recruitment_links=recruitment_plan,
                status=current['status'],
                created_at=current['created_at'],
                updated_at=current.get('updated_at'),
                ended_at=current.get('completed_at'),
            )

    @staticmethod
    def _task_link_plan(value):
        if not value:
            return []
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return []
        return parsed if isinstance(parsed, list) else []
