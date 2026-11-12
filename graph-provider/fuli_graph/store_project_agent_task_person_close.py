"""The person completes or cancels a task themself (rec#123).

An Agent's own completion needs its participating Agent ID and, for a task
that is verified, the exact artifact revision a verifier passed. The person's
own close needs neither: it is their acceptance (FULI is human-authoritative).
It comes only on the console's human-review channel, from the person's click
or from an FLA relaying the person's words through run_delegated_action; the
event is the person's (actor_kind human) and names the relaying FLA, its
client and session. A blocked task's block ends with it.
"""

from types import SimpleNamespace

from fastapi import HTTPException

from .project_agent_task_models import ProjectAgentTaskPersonClose, ProjectAgentTaskRecord
from .provider_values import now_utc, stable_uuid
from .store_project_agent_task_activity import TERMINAL_TASK_STATUSES
from .store_project_agent_task_blockers import STATUS_UPDATE_RESPONSE
from .store_transactions import query_store_transaction
from .task_participant_running import running_since_set


class StoreProjectAgentTaskPersonClose:
    async def close_task_by_person(
        self, actor: dict, task_id: str, request: ProjectAgentTaskPersonClose,
    ) -> ProjectAgentTaskRecord:
        self._require_personal()
        if actor.get('_human_review_verified') is not True:
            raise HTTPException(403, 'only the person closes a task this way, from the local console')
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        async with query_store_transaction(self) as scoped:
            await scoped._lock_task_activity(request.personal_space_id, task_id)
            row = await scoped._find_task_row(request.personal_space_id, task_id, request.personal_project_id)
            if not row:
                raise HTTPException(404, 'project Agent task not found')
            was = dict(row['task'])['status']
            if was in TERMINAL_TASK_STATUSES:
                raise HTTPException(409, f'the task is already {was}; reload it')
            now = now_utc()
            await scoped.runtime.driver.execute_query(
                '''
                MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_TASK]->
                      (task:FuliProjectAgentTask {personal_space_id: $space_id, task_id: $task_id})
                CREATE (event:FuliProjectAgentTaskEvent {
                  id: $event_id, event_id: $event_id, task_id: $task_id,
                  agent_id: $relayed_by, status: $status, actor_kind: 'human',
                  summary: $summary, source_application: $application,
                  source_session_id: $session_id, blocker_cleared_by: $cleared_by,
                  created_at: $updated_at
                })
                MERGE (task)-[:HAS_TASK_EVENT]->(event)
                SET task.status = $status,
                    task.result_summary = $summary,
                    task.completed_at = $updated_at,
                    task.updated_at = $updated_at,
                    task.revision = coalesce(task.revision, 0) + 1
                WITH task
                OPTIONAL MATCH (task)-[participant:HAS_PARTICIPANT]->()
                WHERE NOT coalesce(participant.status, '') IN ['completed', 'failed', 'cancelled']
                FOREACH (_ IN CASE WHEN participant IS NULL THEN [] ELSE [1] END |
                  SET ''' + running_since_set('participant') + '''
                      participant.status = $status,
                      participant.updated_at = $updated_at,
                      participant.ended_at = $updated_at
                )
                ''',
                space_id=request.personal_space_id, task_id=task_id, status=request.status,
                event_id=stable_uuid(self.settings.provider_id, request.personal_space_id,
                                     'project-agent-task-person-close', task_id, now.isoformat()),
                relayed_by=request.relayed_by, summary=request.summary,
                application=request.source_application, session_id=request.source_session_id,
                cleared_by='person' if was == 'blocked' else None, updated_at=now,
            )
            if was == 'blocked':
                await scoped._close_blocker_attention(request.personal_space_id, task_id, STATUS_UPDATE_RESPONSE, now)
            await scoped.close_task_agent_loans(actor, request.personal_space_id, task_id)
            await scoped._archive_finished_temporary_agent(SimpleNamespace(
                status=request.status, personal_space_id=request.personal_space_id, task_id=task_id), None, now)
        return await self.get_project_agent_task(
            actor, request.personal_space_id, task_id, personal_project_id=request.personal_project_id,
        )
