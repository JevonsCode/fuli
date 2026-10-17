"""Keyset pages of the Agent roster in its one global order."""

import base64
import json
from typing import Literal

from fastapi import HTTPException
from pydantic import Field

from .models import StrictModel
from .personal_project_access import authorize_personal_project
from .project_agent_models import ProjectAgentRecord

_TYPE_RANK = {'coordinator': 0, 'hr': 1, 'durable': 2}


class ProjectAgentPage(StrictModel):
    items: list[ProjectAgentRecord]
    # Opaque; null on the last page. ``complete`` is true only then.
    next_cursor: str | None = None
    complete: bool


def encode_cursor(rank: int, name: str, agent_id: str) -> str:
    raw = json.dumps([rank, name, agent_id], ensure_ascii=False, separators=(',', ':'))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip('=')


def decode_cursor(cursor: str) -> tuple[int, str, str]:
    try:
        padded = cursor + '=' * (-len(cursor) % 4)
        rank, name, agent_id = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        if not isinstance(rank, int) or not isinstance(name, str) or not isinstance(agent_id, str):
            raise ValueError
        return rank, name, agent_id
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise HTTPException(status_code=422, detail='invalid roster cursor') from error


class StoreProjectAgentPages:
    async def list_project_agent_page(
        self,
        actor: dict,
        personal_space_id: str,
        personal_project_id: str | None = None,
        *,
        status: str | None = None,
        capability: str | None = None,
        work: Literal['open'] | None = None,
        limit: int = 50,
        cursor: str | None = None,
    ) -> ProjectAgentPage:
        """One page of the same Agents, in the same order, as the full list."""

        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'reader')
        if personal_project_id:
            await authorize_personal_project(self, actor, space, personal_project_id)
        records = await self._project_agent_rows(
            personal_space_id,
            personal_project_id=personal_project_id,
            agent_id=None,
            status=status,
            capability=capability,
            page={
                'after': decode_cursor(cursor) if cursor else None,
                'limit': limit,
                'open_work': work == 'open',
            },
        )
        rows = records[:limit]
        last = dict(rows[-1]['agent']) if rows and len(records) > limit else None
        return ProjectAgentPage(
            items=[
                self._project_agent_from_row(row, personal_space_id, personal_project_id)
                for row in rows
            ],
            next_cursor=encode_cursor(
                _TYPE_RANK.get(last.get('agent_type'), 3),
                last.get('name') or '',
                last['agent_id'],
            ) if last else None,
            complete=last is None,
        )
