"""How an Agent leaves: dismissal with a reason, or cleanup of a test role.

A dismissal archives the identity, ends its assignments and stores one record
with the reason, a few lessons and the handoff document in the same write. Task,
recruitment and routing history stay where they are, and the employee number
stays with the archived identity. A plain archive is kept only for test roles.
"""

from fastapi import HTTPException

from .personal_project_access import authorize_personal_project
from .project_agent_dismissal_models import (
    DEFAULT_LESSON_LIMIT,
    ProjectAgentDismissal,
    ProjectAgentDismissalLesson,
    ProjectAgentDismissalLessons,
    ProjectAgentDismissalReceipt,
    ProjectAgentDismissalRecord,
)
from .project_agent_employee_numbers import employee_number_label
from .project_agent_models import ProjectAgentRecord
from .provider_values import native_datetime, now_utc, stable_uuid
from .system_agents import (
    LEGACY_COORDINATOR_AGENT_ID,
    SYSTEM_ASSISTANT_AGENT_ID,
    SYSTEM_COORDINATOR_AGENT_ID,
    SYSTEM_HR_AGENT_ID,
)
from .system_hr_identity import LEGACY_HR_AGENT_ID

OPEN_TASK_STATUSES = [
    'awaiting_recruitment', 'backlog', 'queued', 'running', 'paused', 'blocked', 'awaiting_review',
]
SYSTEM_ROLE_REFUSALS = {
    SYSTEM_ASSISTANT_AGENT_ID: 'the system assistant cannot be archived',
    SYSTEM_COORDINATOR_AGENT_ID: 'the project manager cannot be archived',
    LEGACY_COORDINATOR_AGENT_ID: 'the project manager cannot be archived',
    SYSTEM_HR_AGENT_ID: 'the system AR cannot be archived',
    LEGACY_HR_AGENT_ID: 'the system AR cannot be archived',
}

# Shared read of one identity under the task lifecycle lock, taken before the
# open-work snapshot so a concurrent task cannot slip past the guards.
_GUARDED_AGENT = '''
    MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
          [:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent {agent_id: $agent_id})
    SET agent._task_lifecycle_lock = true
    REMOVE agent._task_lifecycle_lock
    WITH space, agent
    OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->(task:FuliProjectAgentTask)-
          [participant:HAS_PARTICIPANT]->(agent)
    WHERE participant.status IN $open_statuses
    WITH space, agent, count(DISTINCT task) AS open_task_count
    OPTIONAL MATCH (space)-[:CONTAINS_PROJECT]->(project:FuliPersonalProject)-
          [:HAS_PROJECT_AGENT_ASSIGNMENT]->(assignment:FuliProjectAgentAssignment)-
          [:ASSIGNED_AGENT]->(agent)
    WITH space, agent, open_task_count, collect(DISTINCT assignment) AS assignments,
         [id IN collect(DISTINCT project.project_id) WHERE id IS NOT NULL] AS project_ids
    WITH space, agent, open_task_count, assignments, project_ids,
         coalesce(agent.system_managed, false) AS system_role,
         EXISTS {
           MATCH (space)-[:CONTAINS_PROJECT]->(:FuliPersonalProject)-
                 [:HAS_PROJECT_AGENT_COORDINATION_POLICY]->(policy:FuliProjectAgentCoordinationPolicy)
           WHERE policy.team_lead_agent_id = agent.agent_id
         } AS leads_project
'''

_ARCHIVE = '''
    SET agent.status = 'archived',
        agent.archive_reason = $reason,
        agent.archived_at = $now,
        agent.updated_at = $now
    FOREACH (assignment IN [item IN assignments WHERE item.status = 'active'] |
      SET assignment.status = 'ended',
          assignment.end_reason = $reason,
          assignment.ended_at = $now,
          assignment.updated_at = $now,
          assignment.revision = coalesce(assignment.revision, 0) + 1)
'''

_REFUSALS = {
    'system_role': (422, 'system roles cannot be dismissed'),
    'not_test_role': (409, 'only test roles can be archived directly; dismiss other Agents through the dismissal operation with a reason'),
    'already_archived': (409, 'Agent is already archived'),
    'already_dismissed': (409, 'Agent was already dismissed with a different reason'),
    'project_lead': (409, 'Agent leads a project; hand off the project lead before dismissal'),
}


class StoreProjectAgentDismissal:
    async def dismiss_project_agent(
        self, actor: dict, agent_id: str, request: ProjectAgentDismissal,
    ) -> ProjectAgentDismissalReceipt:
        """Archive one identity and keep its reason, lessons and handoff together."""

        self._require_personal()
        _refuse_system_role(agent_id)
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        records, _, _ = await self.runtime.driver.execute_query(
            _GUARDED_AGENT + '''
            OPTIONAL MATCH (agent)-[:HAS_DISMISSAL]->(existing:FuliProjectAgentDismissal)
            WITH space, agent, open_task_count, assignments, project_ids, system_role,
                 leads_project, head(collect(existing)) AS existing
            WITH space, agent, open_task_count, assignments, project_ids, CASE
                   WHEN existing IS NOT NULL AND existing.reason = $reason THEN 'replayed'
                   WHEN existing IS NOT NULL THEN 'already_dismissed'
                   WHEN system_role THEN 'system_role'
                   WHEN agent.status = 'archived' THEN 'already_archived'
                   WHEN open_task_count > 0 THEN 'open_tasks'
                   WHEN leads_project THEN 'project_lead'
                   ELSE 'dismissed'
                 END AS outcome
            FOREACH (_ IN CASE WHEN outcome = 'dismissed' THEN [1] ELSE [] END |
            ''' + _ARCHIVE + '''
              MERGE (dismissal:FuliProjectAgentDismissal {id: $dismissal_id})
              ON CREATE SET dismissal.dismissal_id = $dismissal_id,
                            dismissal.personal_space_id = $personal_space_id,
                            dismissal.agent_id = agent.agent_id,
                            dismissal.agent_name = coalesce(agent.name, agent.agent_id),
                            dismissal.employee_number = agent.employee_number,
                            dismissal.occupation_role = agent.occupation_role,
                            dismissal.occupation_tags = coalesce(agent.occupation_tags, []),
                            dismissal.project_ids = project_ids,
                            dismissal.reason = $reason,
                            dismissal.lessons = $lessons,
                            dismissal.handoff_filename = $handoff_filename,
                            dismissal.handoff_markdown = $handoff_markdown,
                            dismissal.source_application = $source_application,
                            dismissal.source_session_id = $source_session_id,
                            dismissal.dismissed_at = $now
              MERGE (agent)-[:HAS_DISMISSAL]->(dismissal)
              MERGE (space)-[:HAS_PROJECT_AGENT_DISMISSAL]->(dismissal)
            )
            WITH agent, outcome, open_task_count
            OPTIONAL MATCH (agent)-[:HAS_DISMISSAL]->(record:FuliProjectAgentDismissal)
            RETURN outcome, open_task_count,
                   record {.dismissal_id, .agent_id, .agent_name, .employee_number,
                           .occupation_role, .project_ids, .lessons, .handoff_filename,
                           .dismissed_at, handoff_characters: size(record.handoff_markdown)}
                     AS dismissal
            ''',
            personal_space_id=request.personal_space_id,
            agent_id=agent_id,
            open_statuses=OPEN_TASK_STATUSES,
            dismissal_id=stable_uuid(self.settings.provider_id, request.personal_space_id,
                                     'project-agent-dismissal', agent_id),
            reason=request.reason,
            lessons=request.lessons,
            handoff_filename=request.handoff.filename,
            handoff_markdown=request.handoff.markdown,
            source_application=request.source_application,
            source_session_id=request.source_session_id,
            now=now_utc(),
        )
        row = _outcome_row(records)
        if row['outcome'] not in {'dismissed', 'replayed'}:
            raise HTTPException(*_refusal(row))
        record = dict(row['dismissal'])
        return ProjectAgentDismissalReceipt(
            **_dismissal_fields(record),
            lesson_count=len(record.get('lessons') or []),
            handoff_filename=record['handoff_filename'],
            handoff_characters=record['handoff_characters'],
            replayed=row['outcome'] == 'replayed',
        )

    async def archive_test_project_agent(
        self, actor: dict, personal_space_id: str, agent_id: str, *, reason: str,
    ) -> ProjectAgentRecord:
        """Retire one test-marked role; real Agents leave only through dismissal."""

        self._require_personal()
        _refuse_system_role(agent_id)
        await self.authorize(actor, personal_space_id, 'maintainer')
        if not reason.strip():
            raise HTTPException(status_code=422, detail='archive reason is required')
        records, _, _ = await self.runtime.driver.execute_query(
            _GUARDED_AGENT + '''
            WITH agent, assignments, open_task_count, CASE
                   WHEN system_role THEN 'system_role'
                   WHEN NOT coalesce(agent.cleanup_eligible, false) THEN 'not_test_role'
                   WHEN agent.status = 'archived' THEN 'archived'
                   WHEN open_task_count > 0 THEN 'open_tasks'
                   WHEN leads_project THEN 'project_lead'
                   ELSE 'archived_now'
                 END AS outcome
            FOREACH (_ IN CASE WHEN outcome = 'archived_now' THEN [1] ELSE [] END |
            ''' + _ARCHIVE + '''
            )
            RETURN outcome, open_task_count
            ''',
            personal_space_id=personal_space_id,
            agent_id=agent_id,
            open_statuses=OPEN_TASK_STATUSES,
            reason=reason.strip(),
            now=now_utc(),
        )
        row = _outcome_row(records)
        if row['outcome'] not in {'archived', 'archived_now'}:
            raise HTTPException(*_refusal(row))
        return await self.get_project_agent(actor, personal_space_id, None, agent_id)

    async def list_project_agent_dismissal_lessons(
        self, actor: dict, personal_space_id: str, *, occupations: list[str],
        personal_project_id: str | None, query: str | None, limit: int = DEFAULT_LESSON_LIMIT,
    ) -> ProjectAgentDismissalLessons:
        """Lessons of dismissed Agents of the same occupation or project, newest first."""

        self._require_personal()
        if not occupations and not personal_project_id:
            raise HTTPException(422, 'dismissal lessons need an occupation or a personal project')
        space = await self.authorize(actor, personal_space_id, 'reader')
        if personal_project_id:
            await authorize_personal_project(self, actor, space, personal_project_id)
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_DISMISSAL]->(dismissal:FuliProjectAgentDismissal)
            WITH dismissal,
                 dismissal.occupation_role IN $occupations AS by_occupation,
                 $personal_project_id IN coalesce(dismissal.project_ids, []) AS by_project
            WHERE (by_occupation OR by_project)
              AND ($query IS NULL OR any(text IN [dismissal.reason] + coalesce(dismissal.lessons, [])
                   WHERE toLower(text) CONTAINS toLower($query)))
            WITH dismissal, by_occupation, by_project
            ORDER BY dismissal.dismissed_at DESC, dismissal.dismissal_id
            WITH collect({
              dismissal: dismissal {.dismissal_id, .agent_id, .agent_name, .employee_number,
                                    .occupation_role, .project_ids, .reason, .lessons,
                                    .dismissed_at},
              by_occupation: by_occupation, by_project: by_project
            }) AS rows
            RETURN size(rows) AS total, rows[0..$limit] AS items
            ''',
            personal_space_id=personal_space_id,
            occupations=occupations,
            personal_project_id=personal_project_id,
            query=query.strip() if query and query.strip() else None,
            limit=limit,
            routing_='r',
        )
        row = dict(records[0]) if records else {'total': 0, 'items': []}
        return ProjectAgentDismissalLessons(total=row['total'], items=[
            ProjectAgentDismissalLesson(
                **_dismissal_fields(dict(item['dismissal'])),
                reason=item['dismissal']['reason'],
                lessons=list(item['dismissal'].get('lessons') or []),
                matched_by=[basis for basis, matched in [
                    ('occupation', item['by_occupation']), ('project', item['by_project'])] if matched],
            ) for item in row['items']])

    async def get_project_agent_dismissal(
        self, actor: dict, personal_space_id: str, agent_id: str,
    ) -> ProjectAgentDismissalRecord:
        """The full dismissal record of one archived Agent, including its handoff."""

        self._require_personal()
        await self.authorize(actor, personal_space_id, 'reader')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_IDENTITY]->(:FuliProjectAgent {agent_id: $agent_id})-
                  [:HAS_DISMISSAL]->(dismissal:FuliProjectAgentDismissal)
            RETURN dismissal {.*} AS dismissal
            ''',
            personal_space_id=personal_space_id,
            agent_id=agent_id,
            routing_='r',
        )
        if not records:
            raise HTTPException(status_code=404, detail='Agent dismissal not found')
        record = dict(records[0]['dismissal'])
        return ProjectAgentDismissalRecord(
            **_dismissal_fields(record),
            occupation_tags=list(record.get('occupation_tags') or []),
            reason=record['reason'],
            lessons=list(record.get('lessons') or []),
            handoff={'filename': record['handoff_filename'], 'markdown': record['handoff_markdown']},
            source_application=record.get('source_application'),
            source_session_id=record.get('source_session_id'),
        )


def _refuse_system_role(agent_id):
    if agent_id in SYSTEM_ROLE_REFUSALS:
        raise HTTPException(status_code=422, detail=SYSTEM_ROLE_REFUSALS[agent_id])


def _outcome_row(records):
    if not records:
        raise HTTPException(status_code=404, detail='project Agent not found')
    return dict(records[0])


def _refusal(row):
    if row['outcome'] == 'open_tasks':
        count = row['open_task_count']
        return 409, (f'Agent has {count} open task{"s" if count != 1 else ""}; '
                     'finish, cancel or reassign them before it leaves')
    return _REFUSALS[row['outcome']]


def _dismissal_fields(record):
    return {
        'dismissal_id': record['dismissal_id'],
        'agent_id': record['agent_id'],
        'agent_name': record['agent_name'],
        'employee_number': employee_number_label(record.get('employee_number')),
        'occupation_role': record.get('occupation_role'),
        'project_ids': list(record.get('project_ids') or []),
        'dismissed_at': native_datetime(record['dismissed_at']),
    }
