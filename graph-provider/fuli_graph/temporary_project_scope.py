"""Idempotent task scopes; retain audit history without directory registration."""

import hashlib
import json

from fastapi import HTTPException
from pydantic import Field

from .models import ProjectProfile, SourceApplication, StrictModel
from .provider_values import now_utc, stable_uuid
from .store_transactions import TransactionQueryDriver, query_store_transaction


TEMPORARY_SCOPE = {'type': 'temporary', 'lifetime': 'task', 'persisted': True}


class TemporaryProjectEnsure(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    scope_key: str = Field(pattern=r'^[a-f0-9]{64}$')
    source_application: SourceApplication
    task_context_token: str | None = Field(default=None, pattern=r'^fuli-task-[a-zA-Z0-9-]{8,128}$')


async def ensure_temporary_project(store, actor, request):
    if not isinstance(store.runtime.driver, TransactionQueryDriver):
        async with query_store_transaction(store) as scoped:
            return await ensure_temporary_project(scoped, actor, request)
    store._require_personal()
    await store.authorize(actor, request.personal_space_id, 'maintainer')
    project_id = f'temporary-{request.scope_key}'
    if request.task_context_token:
        expected = hashlib.sha256(json.dumps([
            'fuli-temporary-task-v1', request.personal_space_id,
            request.source_application, request.task_context_token, None,
        ], separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        if expected != request.scope_key:
            raise HTTPException(409, 'Temporary scope does not belong to this task context')
        await _bind_task_context(store, actor, request, project_id)
    node_id = stable_uuid(store.settings.provider_id, request.personal_space_id,
                          'personal-project', project_id)
    profile = ProjectProfile(name='临时任务 / Temporary task', lifecycle='active',
        purpose='Isolated task scope created by explicit Agent coordination.',
        boundaries=['Task-local context only; no implicit project inheritance.',
                    'Audit history is retained after the task ends.'])
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        MERGE (project:FuliPersonalProject {id: $id})
        ON CREATE SET project.project_id = $project_id,
          project.publication_key = $publication_key, project.scope_type = 'temporary',
          project.scope_key = $scope_key, project.profile_json = $profile_json,
          project.name = $name, project.created_at = $now, project.updated_at = $now
        WITH space, project
        WHERE project.scope_type = 'temporary' AND project.scope_key = $scope_key
        MERGE (space)-[:CONTAINS_PROJECT]->(project)
        RETURN project
        ''', space_id=request.personal_space_id, id=node_id, project_id=project_id,
        publication_key=stable_uuid(node_id, 'publication'), scope_key=request.scope_key,
        profile_json=profile.model_dump_json(), name=profile.name, now=now_utc())
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
