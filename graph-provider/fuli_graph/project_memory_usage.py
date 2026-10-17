"""Directional observations of returned project memory; never access authority."""

import os
from datetime import timedelta
from typing import Literal

from fastapi import HTTPException
from pydantic import Field, model_validator

from .models import SourceApplication, StrictModel
from .personal_project_access import authorize_personal_project
from .provider_values import json_object, native_datetime, now_utc, sha256_text, stable_uuid
from .task_context_coordination import task_context_json


class MemoryUsagePolicy(StrictModel):
    frequent_min: int = Field(default=3, ge=1)
    close_min: int = Field(default=10, ge=2)

    @model_validator(mode='after')
    def ordered_thresholds(self):
        if self.frequent_min >= self.close_min:
            raise ValueError('frequent_min must be below close_min')
        return self


class ProjectMemoryUsageCreate(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    task_context_token: str = Field(min_length=1, max_length=256)
    source_application: SourceApplication
    task_id: str | None = Field(default=None, min_length=1, max_length=128)
    target_project_id: str = Field(min_length=1, max_length=128)
    channel: Literal['roundtable_answer', 'read_extension_result']
    evidence_id: str = Field(min_length=1, max_length=256)
    result_count: int = Field(strict=True, ge=0)


def usage_policy():
    return MemoryUsagePolicy(
        frequent_min=int(os.getenv('FULI_MEMORY_USAGE_FREQUENT_MIN', '3')),
        close_min=int(os.getenv('FULI_MEMORY_USAGE_CLOSE_MIN', '10')),
    )


def memory_usage_stats(total, recent, last_used_at, *, policy=None):
    policy = policy or usage_policy()
    tier = ('close' if recent >= policy.close_min else
            'frequent' if recent >= policy.frequent_min else 'related' if total else 'none')
    return dict(totalCount=total, recent30dCount=recent, lastUsedAt=native_datetime(last_used_at),
                tier=tier, suggestKnowledgeReuse=tier == 'close',
                requiresHumanConfirmation=True, grantsAccess=False)


def _business_task_id(context, task_id=None):
    ids = set(context.get('coordination_task_ids') or [])
    if context.get('coordination_task_id'):
        ids.add(context['coordination_task_id'])
    if task_id and task_id not in ids:
        raise HTTPException(409, 'task_id must be bound to this context')
    if len(ids) > 1 and not task_id:
        raise HTTPException(409, 'task_id is required when multiple tasks are bound')
    return task_id or next(iter(ids), None)


def task_usage_key(context, token, task_id=None):
    selected = _business_task_id(context, task_id)
    return sha256_text(('coordination:' + selected) if selected else ('context:' + token))


def _require_formal(project):
    if project.get('scope_type') == 'temporary' or json_object(project.get('profile_json')).get('lifecycle') == 'archived':
        raise HTTPException(409, 'memory usage requires active formal projects')


async def record_project_memory_usage(store, actor, request):
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, 'maintainer')
    context = await store.get_task_context(actor, request.personal_space_id,
                                         request.task_context_token, request.source_application)
    source = context.get('personal_project_id')
    if not source or (context.get('checkpoint') or {}).get('phase') == 'complete':
        raise HTTPException(409, 'memory usage requires an active project task')
    if source == request.target_project_id:
        return {'recorded': False, 'reason': 'same_project'}
    if request.result_count == 0:
        return {'recorded': False, 'reason': 'empty_result'}
    projects = [await authorize_personal_project(store, actor, space, project_id)
                for project_id in [source, request.target_project_id]]
    for project in projects:
        _require_formal(project)
    task_key = task_usage_key(context, request.task_context_token, request.task_id)
    context_keys = [task_usage_key({}, request.task_context_token)]
    business_task_id = _business_task_id(context, request.task_id)
    if business_task_id:
        linked, _, _ = await store.runtime.driver.execute_query('''
            MATCH (:FuliSpace {id: $space_id})-[:HAS_TASK_CONTEXT_SESSION]->()-
                  [:HAS_CONTEXT]->(context:FuliTaskContext)-[:COORDINATES_TASK]->(task:FuliProjectAgentTask)
            WHERE task.task_id = $task_id RETURN context.token AS token
            ''', space_id=space['id'], task_id=business_task_id, routing_='r')
        context_keys = sorted(set(context_keys + [task_usage_key({}, row['token']) for row in linked]))
    event_id = stable_uuid('project-memory-usage-v1', space['id'], source,
                           request.target_project_id, task_key)
    rows, _, _ = await store.runtime.driver.execute_query(
        RECORD_USAGE, space_id=space['id'], source=source, target=request.target_project_id,
        token=request.task_context_token, event_id=event_id, task_key=task_key,
        context_keys=context_keys,
        channel=request.channel, evidence_hash=sha256_text(request.evidence_id), now=now_utc(),
        context_json=task_context_json(context), source_profile=projects[0]['profile_json'],
        target_profile=projects[1]['profile_json'])
    if not rows:
        raise HTTPException(409, 'task context or project scope changed before recording')
    return {'recorded': True, 'event_id': rows[0]['event_id'], 'created': rows[0]['created']}


RECORD_USAGE = '''
MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-[:CONTAINS_PROJECT]->
      (source:FuliPersonalProject {project_id: $source})
MATCH (space)-[:CONTAINS_PROJECT]->(target:FuliPersonalProject {project_id: $target})
MATCH (space)-[:HAS_TASK_CONTEXT_SESSION]->(session:FuliTaskContextSession)-
      [:HAS_CONTEXT]->(context:FuliTaskContext {token: $token})
WHERE session.current_token = context.token
  AND context.record_json = $context_json
  AND source.profile_json = $source_profile AND target.profile_json = $target_profile
  AND coalesce(source.scope_type, 'formal') <> 'temporary'
  AND coalesce(target.scope_type, 'formal') <> 'temporary'
SET source._memory_usage_lock = true
REMOVE source._memory_usage_lock
WITH source, target
OPTIONAL MATCH (source)-[prior:PROJECT_MEMORY_ACCESS]->(target)
WHERE prior.task_key = $task_key OR
      any(key IN coalesce(prior.context_keys, []) WHERE key IN $context_keys)
WITH source, target, prior ORDER BY prior.used_at, prior.id
WITH source, target, collect(prior) AS previous
FOREACH (prior IN previous | SET prior.task_key = $task_key)
WITH source, target, coalesce(head(previous).id, $event_id) AS event_id
MERGE (source)-[usage:PROJECT_MEMORY_ACCESS {id: event_id}]->(target)
ON CREATE SET usage.task_key = $task_key, usage.used_at = $now,
              usage.channel = $channel, usage.evidence_hash = $evidence_hash,
              usage._created = true
SET usage.context_keys = reduce(keys = coalesce(usage.context_keys, []), key IN $context_keys |
                               CASE WHEN key IN keys THEN keys ELSE keys + [key] END)
WITH usage, coalesce(usage._created, false) AS created
REMOVE usage._created
RETURN created, usage.id AS event_id
'''


async def read_project_memory_usage(store, space_id, project_id=None, *, now=None, policy=None):
    now = now or now_utc()
    rows, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-[:CONTAINS_PROJECT]->
              (source:FuliPersonalProject)-[usage:PROJECT_MEMORY_ACCESS]->(target:FuliPersonalProject)
        MATCH (space)-[:CONTAINS_PROJECT]->(target)
        WHERE ($project_id IS NULL OR source.project_id = $project_id OR target.project_id = $project_id)
          AND coalesce(source.scope_type, 'formal') <> 'temporary'
          AND coalesce(target.scope_type, 'formal') <> 'temporary'
        WITH source, target, usage.task_key AS task_key, min(usage.used_at) AS used_at
        RETURN source.project_id AS source_project_id, source.name AS source_name,
               source.profile_json AS source_profile, target.profile_json AS target_profile,
               target.project_id AS target_project_id, target.name AS target_name,
               count(task_key) AS total_count,
               count(CASE WHEN used_at >= $cutoff AND used_at <= $now
                     THEN task_key END) AS recent_count, max(used_at) AS last_used_at
        ORDER BY recent_count DESC, total_count DESC, target_project_id
        ''', space_id=space_id, project_id=project_id, cutoff=now - timedelta(days=30), now=now, routing_='r')
    result = []
    for row in rows:
        if any(json_object(row[key]).get('lifecycle') == 'archived' for key in ['source_profile', 'target_profile']):
            continue
        result.append({key: row[key] for key in ['source_project_id', 'source_name', 'target_project_id', 'target_name']} | {
            'id': stable_uuid('project-memory-weight-v1', space_id, row['source_project_id'], row['target_project_id']),
            'statistics': memory_usage_stats(row['total_count'], row['recent_count'], row['last_used_at'], policy=policy),
        })
    return result
