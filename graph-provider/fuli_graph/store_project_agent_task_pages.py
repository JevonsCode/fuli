"""Keyset pages of a space's Agent tasks for the console's full lists.

The workbench shows seven rows of 进行中 and 最近完成; each list's own page
reads the rest here, a page at a time, filtered and sorted on the graph. A row
carries the task and its participants but not its event history, so a long
list stays cheap to read; the task's own view still loads its events.
"""

import base64
import json
from datetime import datetime
from collections.abc import Sequence
from typing import Literal

from fastapi import HTTPException

from .models import StrictModel
from .personal_project_access import authorize_personal_project
from .project_agent_task_models import ProjectAgentTaskRecord, ProjectAgentTaskStatus
from .provider_values import native_datetime
from .system_hr_identity import resolve_hr_alias

TaskPageOrder = Literal['updated', 'completed']
TaskPageSort = Literal['newest', 'oldest']

# The time each order reads; a finished task without its own time falls back to its last change.
_ORDER_TIME = {
    'updated': 'task.updated_at',
    'completed': 'coalesce(task.completed_at, task.updated_at)',
}


class ProjectAgentTaskPage(StrictModel):
    items: list[ProjectAgentTaskRecord]
    # Opaque; null on the last page.
    next_cursor: str | None = None
    # How many tasks match, counted only for the first page.
    total: int | None = None


def encode_task_cursor(at: datetime, task_id: str) -> str:
    raw = json.dumps([at.isoformat(), task_id], separators=(',', ':'))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip('=')


def decode_task_cursor(cursor: str) -> tuple[str, str]:
    try:
        padded = cursor + '=' * (-len(cursor) % 4)
        at, task_id = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        if not isinstance(at, str) or not isinstance(task_id, str):
            raise ValueError
        datetime.fromisoformat(at)
        return at, task_id
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise HTTPException(status_code=422, detail='invalid task cursor') from error


def _page_query(order: TaskPageOrder, sort: TaskPageSort) -> tuple[str, str]:
    """The filter and page clauses; the count reuses the filter alone."""

    at = _ORDER_TIME[order]
    direction = 'DESC' if sort == 'newest' else 'ASC'
    beyond = '<' if sort == 'newest' else '>'
    match = f'''
        MATCH (space:FuliSpace {{id: $personal_space_id, kind: 'personal'}})-
              [:HAS_PROJECT_AGENT_TASK]->
              (task:FuliProjectAgentTask {{personal_space_id: $personal_space_id}})
        WHERE task.status IN $statuses
          AND (size($project_ids) = 0 OR task.personal_project_id IN $project_ids)
          AND (size($agent_ids) = 0
               OR task.lead_agent_id IN $agent_ids
               OR EXISTS {{
                 MATCH (task)-[:HAS_PARTICIPANT]->(member:FuliProjectAgent)
                 WHERE member.agent_id IN $agent_ids
               }})
          AND ($text IS NULL
               OR toLower(coalesce(task.title, '')) CONTAINS $text
               OR toLower(coalesce(task.objective, '')) CONTAINS $text
               OR toLower(coalesce(task.result_summary, '')) CONTAINS $text)
          AND ($started_since IS NULL OR task.created_at >= datetime($started_since))
          AND ($changed_before IS NULL OR task.updated_at < datetime($changed_before))
          AND ($has_result IS NULL OR (trim(coalesce(task.result_summary, '')) <> '') = $has_result)
          AND ($took_at_least IS NULL AND $took_at_most IS NULL OR (
               duration.inSeconds(task.created_at, coalesce(task.completed_at, task.updated_at)).seconds >= coalesce($took_at_least, 0)
               AND ($took_at_most IS NULL
                    OR duration.inSeconds(task.created_at, coalesce(task.completed_at, task.updated_at)).seconds < $took_at_most)))
        WITH task, {at} AS at
        WHERE ($since IS NULL OR at >= datetime($since))
          AND ($until IS NULL OR at < datetime($until))
    '''
    page = f'''
        WITH task, at
        WHERE $after_at IS NULL
           OR at {beyond} datetime($after_at)
           OR (at = datetime($after_at) AND task.task_id > $after_id)
        WITH task, at ORDER BY at {direction}, task.task_id LIMIT $limit
        OPTIONAL MATCH (task)-[participant:HAS_PARTICIPANT]->(participant_agent:FuliProjectAgent)
        WITH task, at, collect(DISTINCT {{
          agent_id: participant_agent.agent_id,
          agent_name: participant_agent.name,
          occupation_emoji: participant_agent.occupation_emoji,
          role: participant.role,
          status: participant.status,
          assignment_summary: participant.assignment_summary,
          profile_json: participant_agent.profile_json,
          joined_at: participant.joined_at,
          updated_at: participant.updated_at,
          ended_at: participant.ended_at,
          running_since: participant.running_since
        }}) AS participant_rows
        OPTIONAL MATCH (task)-[:ROUTED_BY]->(decision:FuliProjectAgentRoutingDecision)
        RETURN task, at, participant_rows, [] AS event_rows, decision
        ORDER BY at {direction}, task.task_id
    '''
    return match, page


class StoreProjectAgentTaskPages:
    async def list_project_agent_task_page(
        self,
        actor: dict,
        personal_space_id: str,
        *,
        statuses: Sequence[ProjectAgentTaskStatus],
        project_ids: Sequence[str] = (),
        agent_ids: Sequence[str] = (),
        text: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        started_since: datetime | None = None,
        changed_before: datetime | None = None,
        has_result: bool | None = None,
        took_at_least: int | None = None,
        took_at_most: int | None = None,
        order: TaskPageOrder = 'updated',
        sort: TaskPageSort = 'newest',
        limit: int = 50,
        cursor: str | None = None,
    ) -> ProjectAgentTaskPage:
        """One page of the space's tasks that match, in the asked order.

        Each list adds its own narrowing: work started since a time, work
        quiet since a time (no change before `changed_before`), finished work
        with or without a result summary, and how long it took in seconds
        from creation to completion (`took_at_least` <= took < `took_at_most`).
        """

        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'reader')
        for project_id in project_ids:
            await authorize_personal_project(self, actor, space, project_id)
        agents = [await resolve_hr_alias(self, personal_space_id, agent_id) for agent_id in agent_ids]
        after_at, after_id = decode_task_cursor(cursor) if cursor else (None, None)
        match, page = _page_query(order, sort)
        values = {
            'personal_space_id': personal_space_id,
            'statuses': list(statuses),
            'project_ids': list(project_ids),
            'agent_ids': agents,
            'text': text.strip().lower() if text and text.strip() else None,
            'since': since.isoformat() if since else None,
            'until': until.isoformat() if until else None,
            'started_since': started_since.isoformat() if started_since else None,
            'changed_before': changed_before.isoformat() if changed_before else None,
            'has_result': has_result,
            'took_at_least': took_at_least,
            'took_at_most': took_at_most,
        }
        # One more row than the page says whether another page follows.
        records, _, _ = await self.runtime.driver.execute_query(
            match + page, **values, after_at=after_at, after_id=after_id,
            limit=limit + 1, routing_='r',
        )
        total = None
        if not cursor:
            counted, _, _ = await self.runtime.driver.execute_query(
                match + 'RETURN count(task) AS total', **values, routing_='r',
            )
            total = counted[0]['total'] if counted else 0
        rows = records[:limit]
        last = rows[-1] if rows and len(records) > limit else None
        return ProjectAgentTaskPage(
            items=[self._task_from_row(row) for row in rows],
            next_cursor=encode_task_cursor(native_datetime(last['at']), dict(last['task'])['task_id']) if last else None,
            total=total,
        )
