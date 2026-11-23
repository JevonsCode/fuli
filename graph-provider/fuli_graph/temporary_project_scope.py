"""Idempotent task scopes; retain audit history without directory registration."""

import hashlib
import json
import re

from fastapi import HTTPException
from typing import Literal

from pydantic import Field

from .models import ProjectProfile, SourceApplication, StrictModel
from .provider_values import json_object, now_utc, stable_uuid
from .store_transactions import TransactionQueryDriver, query_store_transaction


TEMPORARY_SCOPE = {'type': 'temporary', 'lifetime': 'task', 'persisted': True}
# The scope_type a task's project holds now, as a Cypher expression over a bound
# `task` (tasks copied it when created; graph/23 marks their project temporary
# later). A task hangs off its own project (store_project_agent_tasks.py MERGE
# (project)-[:HAS_PROJECT_AGENT_TASK]->(task)): one hop. A task written without
# that edge falls back to the space's project of the same ID. CASE evaluates
# only the branch it takes, so a task with the edge never fans out over the
# space's projects. Only a real Neo4j runs this (CI provider-neo4j).
TASK_PROJECT_SCOPE_TYPE = """CASE
  WHEN EXISTS { MATCH (task)<-[:HAS_PROJECT_AGENT_TASK]-(:FuliPersonalProject {project_id: task.personal_project_id}) }
  THEN head([(task)<-[:HAS_PROJECT_AGENT_TASK]-(direct:FuliPersonalProject {project_id: task.personal_project_id})
             | direct.scope_type])
  ELSE head([(task)<-[:HAS_PROJECT_AGENT_TASK]-(:FuliSpace)-[:CONTAINS_PROJECT]->
             (scope_project:FuliPersonalProject {project_id: task.personal_project_id}) | scope_project.scope_type])
END"""
# No name: nobody named these, so there is nothing to store. Every reader shows
# a temporary project in the person's own language, told apart by its short
# number, its date and whatever title someone later gave it. Before graph/23 the
# two profiles below carried '临时任务 / Temporary task' and
# '临时会话 / Temporary session'; graph_format_temporary_names.py clears those.
_TASK_PROFILE = ProjectProfile(lifecycle='active',
    purpose='Isolated task scope created by explicit Agent coordination.',
    boundaries=['Task-local context only; no implicit project inheritance.',
                'Audit history is retained after the task ends.'])
_SESSION_PROFILE = ProjectProfile(lifecycle='active',
    purpose='Holds what a session saved before anyone chose where it applies.',
    boundaries=['Scope pending: nothing here applies to other projects or FLAs.',
                'Items move only when the person chooses their scope.'])
# Every name FULI ever generated for a project it opened by itself. graph/23
# clears them; until a person confirms that step a graph still holds them.
GENERATED_NAMES = (
    '临时任务 / Temporary task',
    '临时会话 / Temporary session',
    '会话项目 / Conversation project',
)
# A generated temporary project ID: a session or task scope this module derives,
# or the conversation fallback task entry wrote until 2026-10-18. A name a person
# typed can make a readable ID such as 'temporary-fix'; that is never this.
_GENERATED_ID = re.compile(r'^(?:temporary|conversation)-([0-9a-f]{64})$')


class TemporaryProjectEnsure(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    scope_key: str = Field(pattern=r'^[a-f0-9]{64}$')
    source_application: SourceApplication
    task_context_token: str | None = Field(default=None, pattern=r'^fuli-task-[a-zA-Z0-9-]{8,128}$')
    # session: holds a session's knowledge whose scope nobody chose yet (rec#20).
    lifetime: Literal['task', 'session'] = 'task'


def session_temporary_project_id(space_id: str, source_application: str, session_id: str) -> str:
    """The temporary project of one host session (rec#20): the same key the
    console's ensureSessionTemporaryProject asks for, so the session's batch
    migration finds exactly what that session held, and nothing else."""
    return 'temporary-' + _scope_key(['fuli-temporary-session-v1', space_id, source_application, session_id])


def conversation_fallback_project_id(space_id: str, source_application: str, session_id: str) -> str:
    """The project task entry created for an unmatched session until 2026-10-18
    (removed in e50b04c2; its projects remain): the same key that code asked for."""
    return 'conversation-' + _scope_key(['fuli-conversation-project-v1', space_id, source_application, session_id])


def stored_project_name(name_column: str | None, profile_json) -> str:
    """The name a project holds: its profile's, as the console and Node read it
    (web temporary-project-name.ts, src/graphiti/project-display-name.js), and
    the `name` column only where the profile has no name field at all. The two
    disagree only in a graph an earlier FULI or another tool wrote."""
    profile = json_object(profile_json)
    return str(profile['name'] if isinstance(profile.get('name'), str) else name_column or '')


def is_temporary_project(project_id: str, scope_type: str | None, name: str | None) -> bool:
    """Whether a project is one FULI opened by itself. Its scope_type says so
    first. `name`: stored_project_name.

    Compatibility, not a rule of its own: a generated ID still holding no name
    or a generated one counts too. That is a conversation fallback a graph
    waiting for graph/23 has not marked yet; graph/23 marks every one of them
    temporary. Remove this fallback together with the generated names once no
    supported FULI opens a graph below 23 (the same fallback lives in Node's
    project-display-name.js and the console's project-origin.ts). A
    conversation project a person named stays theirs."""
    if scope_type == 'temporary':
        return True
    return bool(_GENERATED_ID.match(project_id)) and (name or '').strip() in ('', *GENERATED_NAMES)

# As long as the console's own short number (web temporary-project-name.ts).
_NUMBER_LENGTH = 8


def project_reference(project_id: str, name: str) -> str:
    """How text FULI writes about a project refers to it: its name, or, for a
    project nobody named, '#' and the same short number the console shows."""
    if name:
        return name
    digest = _GENERATED_ID.match(project_id)
    return f'#{digest.group(1)[:_NUMBER_LENGTH] if digest else project_id}'


def _scope_key(parts: list) -> str:
    return hashlib.sha256(json.dumps(parts, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


async def ensure_temporary_project(store, actor, request):
    if not isinstance(store.runtime.driver, TransactionQueryDriver):
        async with query_store_transaction(store) as scoped:
            return await ensure_temporary_project(scoped, actor, request)
    store._require_personal()
    await store.authorize(actor, request.personal_space_id, 'maintainer')
    project_id = f'temporary-{request.scope_key}'
    if request.task_context_token:
        expected = _scope_key(['fuli-temporary-task-v1', request.personal_space_id,
                               request.source_application, request.task_context_token, None])
        if expected != request.scope_key:
            raise HTTPException(409, 'Temporary scope does not belong to this task context')
        await _bind_task_context(store, actor, request, project_id)
    node_id = stable_uuid(store.settings.provider_id, request.personal_space_id,
                          'personal-project', project_id)
    profile = _SESSION_PROFILE if request.lifetime == 'session' else _TASK_PROFILE
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        MERGE (project:FuliPersonalProject {id: $id})
        ON CREATE SET project.project_id = $project_id,
          project.publication_key = $publication_key, project.scope_type = 'temporary',
          project.scope_key = $scope_key, project.profile_json = $profile_json,
          project.name = '', project.created_at = $now, project.updated_at = $now
        WITH space, project
        WHERE project.scope_type = 'temporary' AND project.scope_key = $scope_key
        MERGE (space)-[:CONTAINS_PROJECT]->(project)
        RETURN project
        ''', space_id=request.personal_space_id, id=node_id, project_id=project_id,
        publication_key=stable_uuid(node_id, 'publication'), scope_key=request.scope_key,
        profile_json=profile.model_dump_json(), now=now_utc())
    if not records:
        raise HTTPException(409, 'Temporary scope conflicts with an existing project')
    return store._personal_project(records[0]['project'], request.personal_space_id)


async def _bind_task_context(store, actor, request, project_id):
    record = await store.get_task_context(actor, request.personal_space_id,
        request.task_context_token, request.source_application)
    if record.get('personal_project_id') == project_id and record.get('project_scope') == TEMPORARY_SCOPE:
        return
    if record.get('personal_project_id') or record.get('project_agent_id') or record.get('checkpoint'):
        raise HTTPException(409, 'Task context cannot change its project scope')
    before = json.dumps(record, ensure_ascii=False)
    record.update(personal_project_id=project_id, project_scope=TEMPORARY_SCOPE)
    rows, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_TASK_CONTEXT_SESSION]->
          (session:FuliTaskContextSession)-[:HAS_CONTEXT]->(context:FuliTaskContext {token: $token})
        SET session.write_serial = coalesce(session.write_serial, 0) + 1
        WITH session, context
        WHERE session.current_token = context.token AND context.personal_project_id IS NULL
          AND context.project_agent_id IS NULL AND context.fingerprint IS NULL
          AND NOT context.completed AND context.record_json = $before
        SET context.personal_project_id = $project_id, context.record_json = $record_json
        RETURN context.record_json AS record_json
        ''', space_id=request.personal_space_id, token=request.task_context_token,
        project_id=project_id, before=before, record_json=json.dumps(record, ensure_ascii=False))
    if not rows:
        raise HTTPException(409, 'Task context changed or was superseded during temporary scope binding')
