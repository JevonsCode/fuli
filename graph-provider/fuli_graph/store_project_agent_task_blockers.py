"""Ending a task's block when the session that reported it moves on, or on the person's word.

A block belongs to the client session that reported it. When that same
session records more work, or the person replies in it, or the person answers
the block's request in FULI, the task leaves blocked: one system event records
why and when, and the block's open requests leave the person's queue.

Work in another session is weaker evidence: the block may have been solved
there, or not. When one of the task's Agents records work in its project from
another session, the block stays and FULI notes it as probably resolved, for
the person to confirm with one click (FULI is human-authoritative).

A session that will never continue leaves its block in place, so the person
can also mark it cleared from the console (「标记为已解除」), or an FLA that
solved it does that for them through run_delegated_action, with its reason.
That write comes only on the human-review channel; an Agent's access token
alone is refused.
"""

from fastapi import HTTPException

from .project_agent_task_models import (
    BlockerClearCause,
    ProjectAgentTaskBlockerClear,
    ProjectAgentTaskBlockerClearResult,
    ProjectAgentTaskBlockerPersonClear,
    ProjectAgentTaskBlockerProgress,
    ProjectAgentTaskBlockerProgressResult,
    ProjectAgentTaskRecord,
)
from .provider_values import now_utc, stable_uuid
from .store_transactions import query_store_transaction
from .task_blocker import PERSON_CLEAR_SUMMARY, PERSON_CONFIRM_SUMMARY, blocked_in_session
from .task_participant_running import running_since_set

CLEAR_SUMMARIES = {
    'session_activity': 'Unblocked automatically: the session that reported the block recorded more work.',
    'session_reply': 'Unblocked automatically: the person replied in the session that reported the block.',
    'attention_answer': 'Unblocked automatically: the person answered the blocking request in FULI.',
    'person': PERSON_CLEAR_SUMMARY,
    'person_confirmed': PERSON_CONFIRM_SUMMARY,
}
# Who each clear's event is recorded as; the session causes are the system's.
ACTOR_KINDS = {'person': 'human', 'person_confirmed': 'human', 'agent': 'agent'}
# A blocked task's own status report that moves it on.
STATUS_UPDATE_RESPONSE = 'The task left blocked with its own status update.'
# The requests that stand for a block in the person's queue.
BLOCKER_ATTENTION_KINDS = ('blocked', 'question')


class StoreProjectAgentTaskBlockers:
    async def clear_session_task_blockers(
        self, actor: dict, request: ProjectAgentTaskBlockerClear,
    ) -> ProjectAgentTaskBlockerClearResult:
        """End every block in this space that this exact client session reported."""
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        rows, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask {personal_space_id: $space_id, status: 'blocked'})
                  -[:HAS_TASK_EVENT]->(event:FuliProjectAgentTaskEvent {
                    source_session_id: $session_id, status: 'blocked'
                  })
            WHERE event.source_application = $application
            RETURN DISTINCT task.task_id AS task_id
            ''',
            space_id=request.personal_space_id, session_id=request.source_session_id,
            application=request.source_application, routing_='r',
        )
        cleared = []
        for row in rows:
            if await self._clear_task_blocker(
                request.personal_space_id, row['task_id'], request.cause,
                session=(request.source_application, request.source_session_id),
            ):
                cleared.append(row['task_id'])
        return ProjectAgentTaskBlockerClearResult(cleared_task_ids=cleared)

    async def clear_task_blocker_by_person(
        self, actor: dict, task_id: str, request: ProjectAgentTaskBlockerPersonClear,
    ) -> ProjectAgentTaskRecord:
        """The person's 「标记为已解除」: end this task's block whichever session reported it.

        The same console write carries an FLA's clear for the person (cause
        'agent', its reason as the summary) and the person's confirmation of a
        probable resolution ('person_confirmed').
        """
        self._require_personal()
        if actor.get('_human_review_verified') is not True:
            raise HTTPException(403, 'only the person marks a block cleared, from the local console')
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        if not await self._find_task_row(request.personal_space_id, task_id, request.personal_project_id):
            raise HTTPException(404, 'project Agent task not found')
        agent = request.cleared_by == 'agent'
        cause = 'agent' if agent else 'person_confirmed' if request.confirm_hint else 'person'
        clearer = {'agent_id': request.agent_id, 'application': request.source_application,
                   'session_id': request.source_session_id} if agent else None
        if not await self._clear_task_blocker(
            request.personal_space_id, task_id, cause,
            project_id=request.personal_project_id, note=request.note, clearer=clearer,
            resume_status=request.resume_status,
        ):
            raise HTTPException(409, 'the task is no longer blocked, or nothing says it is probably resolved; reload it')
        return await self.get_project_agent_task(
            actor, request.personal_space_id, task_id, personal_project_id=request.personal_project_id,
        )

    async def note_blocker_progress(
        self, actor: dict, request: ProjectAgentTaskBlockerProgress,
    ) -> ProjectAgentTaskBlockerProgressResult:
        """This Agent recorded work in the project from this session: its blocks
        reported in any other session become probably resolved. The status stays."""
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        rows, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask {
                    personal_space_id: $space_id, personal_project_id: $project_id, status: 'blocked'
                  })
            WHERE task.lead_agent_id = $agent_id
               OR EXISTS { MATCH (task)-[:HAS_PARTICIPANT]->(:FuliProjectAgent {agent_id: $agent_id}) }
            RETURN DISTINCT task.task_id AS task_id
            ''',
            space_id=request.personal_space_id, project_id=request.personal_project_id,
            agent_id=request.agent_id, routing_='r',
        )
        hinted = []
        for row in rows:
            if await self._hint_task_blocker(request, row['task_id']):
                hinted.append(row['task_id'])
        return ProjectAgentTaskBlockerProgressResult(hinted_task_ids=hinted)

    async def _hint_task_blocker(self, request: ProjectAgentTaskBlockerProgress, task_id: str) -> bool:
        session = (request.source_application, request.source_session_id)
        async with query_store_transaction(self) as scoped:
            await scoped._lock_task_activity(request.personal_space_id, task_id)
            row = await scoped._find_task_row(request.personal_space_id, task_id, request.personal_project_id)
            blocker = scoped._blocker_from_row(row) if row else None
            # The reporting session's own work ends its block instead.
            if not blocker or blocked_in_session(blocker, *session):
                return False
            await scoped.runtime.driver.execute_query(
                '''
                MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_TASK]->
                      (task:FuliProjectAgentTask {
                        personal_space_id: $space_id, task_id: $task_id, status: 'blocked'
                      })
                SET task.blocker_hint_agent_id = $agent_id,
                    task.blocker_hint_source_application = $application,
                    task.blocker_hint_source_session_id = $session_id,
                    task.blocker_hint_at = $at
                ''',
                space_id=request.personal_space_id, task_id=task_id, agent_id=request.agent_id,
                application=request.source_application, session_id=request.source_session_id, at=now_utc(),
            )
        return True

    async def _clear_task_blocker(
        self, space_id: str, task_id: str, cause: BlockerClearCause, *, session=None,
        project_id=None, note=None, clearer=None, resume_status='running',
    ) -> bool:
        """Move one blocked task to running (or queued). session, when given, must be the reporting one.

        The person's own clear ('person') is a human event whose summary is
        their note; their confirmation ('person_confirmed') needs the block's
        probable resolution and names its Agent and session; an FLA's clear
        ('agent') names the FLA (clearer) and its reason; every other cause is
        a system event.
        """
        async with query_store_transaction(self) as scoped:
            await scoped._lock_task_activity(space_id, task_id)
            row = await scoped._find_task_row(space_id, task_id, project_id)
            blocker = scoped._blocker_from_row(row) if row else None
            if not blocker or (session and not blocked_in_session(blocker, *session)):
                return False
            hint = blocker.probably_resolved
            if cause == 'person_confirmed' and not hint:
                return False
            if cause == 'person_confirmed':
                clearer = {'agent_id': hint.agent_id, 'application': hint.source_application,
                           'session_id': hint.source_session_id}
            elif session:
                clearer = {'agent_id': blocker.agent_id, 'application': session[0], 'session_id': session[1]}
            elif not clearer:
                clearer = {'agent_id': blocker.agent_id, 'application': None, 'session_id': None}
            now = now_utc()
            summary = note or CLEAR_SUMMARIES[cause]
            await scoped.runtime.driver.execute_query(
                '''
                MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_TASK]->
                      (task:FuliProjectAgentTask {
                        personal_space_id: $space_id, task_id: $task_id, status: 'blocked'
                      })
                CREATE (event:FuliProjectAgentTaskEvent {
                  id: $event_id, event_id: $event_id, task_id: $task_id,
                  agent_id: $agent_id, status: $resume_status, actor_kind: $actor_kind,
                  summary: $summary, source_application: $application,
                  source_session_id: $session_id, blocker_cleared_by: $cause,
                  created_at: $updated_at
                })
                MERGE (task)-[:HAS_TASK_EVENT]->(event)
                SET task.status = $resume_status,
                    task.updated_at = $updated_at,
                    task.revision = coalesce(task.revision, 0) + 1
                WITH task
                OPTIONAL MATCH (task)-[participant:HAS_PARTICIPANT]->()
                WHERE participant.status = 'blocked'
                FOREACH (_ IN CASE WHEN participant IS NULL THEN [] ELSE [1] END |
                  SET ''' + running_since_set('participant', '$resume_status') + '''
                      participant.status = $resume_status,
                      participant.updated_at = $updated_at
                )
                ''',
                resume_status=resume_status,
                space_id=space_id, task_id=task_id,
                event_id=stable_uuid(
                    self.settings.provider_id, space_id, 'project-agent-task-blocker-clear',
                    task_id, now.isoformat(),
                ),
                agent_id=clearer['agent_id'], summary=summary, cause=cause,
                actor_kind=ACTOR_KINDS.get(cause, 'system'),
                application=clearer['application'], session_id=clearer['session_id'], updated_at=now,
            )
            await scoped._close_blocker_attention(space_id, task_id, summary, now)
        return True

    async def _lock_task_activity(self, space_id, task_id):
        """Hold the task's activity write lock for the rest of the transaction."""
        await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask {personal_space_id: $space_id, task_id: $task_id})
            SET task._activity_write_lock = true
            REMOVE task._activity_write_lock
            ''', space_id=space_id, task_id=task_id,
        )

    async def _close_blocker_attention(self, space_id, task_id, response, at):
        """Take the task's open blocking requests out of the person's queue."""
        await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_AGENT_ATTENTION]->
                  (request:FuliAgentAttention {task_id: $task_id, status: 'open'})
            WHERE request.kind IN $kinds
            SET request.lock_version = coalesce(request.lock_version, 0) + 1,
                request.status = 'cancelled', request.response = $response,
                request.responded_by = 'system', request.revision = request.revision + 1,
                request.updated_at = $at
            ''',
            space_id=space_id, task_id=task_id, kinds=list(BLOCKER_ATTENTION_KINDS),
            response=response, at=at,
        )
