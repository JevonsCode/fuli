"""Persistent executor directory and policy-aware Agent routing.

This mixin is intentionally independent from the HTTP router and from the
worker/scheduler.  ``GraphStore`` can compose it when its public endpoints are
ready.  Every mutation is scoped through the existing space/project
authorizers, and every selection records the exact rule, candidate order,
fallback, or blocking reason that was used.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from fastapi import HTTPException

from .personal_project_access import authorize_personal_project
from .project_agent_executor_models import (
    ProjectAgentExecutorActualReport,
    ProjectAgentExecutorAuthorization,
    ProjectAgentExecutorHealthReport,
    ProjectAgentExecutorModelRecord,
    ProjectAgentExecutorPermissionStatus,
    ProjectAgentExecutorPreflightReport,
    ProjectAgentExecutorRecord,
    ProjectAgentExecutorRegistration,
    ProjectAgentExecutorRegistrationStatus,
    ProjectAgentExecutorRoutingRuleCreate,
    ProjectAgentExecutorRoutingRuleRecord,
    ProjectAgentExecutorRoutingRuleUpdate,
    ProjectAgentExecutorScope,
    project_agent_model_strategy_key,
)
from .project_agent_models import (
    ProjectAgentExecutorPolicy, ProjectAgentModelStrategy, ProjectAgentProfile,
)
from .provider_values import native_datetime, now_utc, stable_uuid
from .store_project_agent_executor_learning import StoreProjectAgentExecutorLearning
from .store_project_agent_executor_routing import StoreProjectAgentExecutorRouting
from .store_transactions import query_store_transaction


class StoreProjectAgentExecutors(
    StoreProjectAgentExecutorRouting,
    StoreProjectAgentExecutorLearning,
):
    """Durable executor directory, routing rules, and outcome evidence."""

    async def register_project_agent_executor(
        self,
        actor: dict,
        request: ProjectAgentExecutorRegistration,
    ) -> ProjectAgentExecutorRecord:
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        executor_id = stable_uuid(
            self.settings.provider_id,
            'project-agent-executor',
            request.personal_space_id,
            request.executor_id,
        )
        payload_hash = self._payload_hash(request)
        timestamp = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})
            MERGE (executor:FuliProjectAgentExecutor {id: $executor_id})
            ON CREATE SET executor.executor_id = $public_executor_id,
                          executor.personal_space_id = $personal_space_id,
                          executor.payload_hash = $payload_hash,
                          executor.display_name = $display_name,
                          executor.executor_kind = $executor_kind,
                          executor.capabilities = $capabilities,
                          executor.advertised_models_json = $models_json,
                          executor.global_priority = $global_priority,
                          executor.health_required = $health_required,
                          executor.registration_status = 'registered',
                          executor.permission_status = 'pending',
                          executor.preflight_status = 'not_run',
                          executor.health_status = 'unknown',
                          executor.revision = 0,
                          executor.test_source = $test_source,
                          executor.cleanup_eligible = $cleanup_eligible,
                          executor.registered_at = $timestamp,
                          executor.updated_at = $timestamp
            MERGE (space)-[permission:HAS_EXECUTOR_PERMISSION]->(executor)
            ON CREATE SET permission.status = 'pending',
                          permission.revision = 0,
                          permission.updated_at = $timestamp
            RETURN executor, permission
            ''',
            personal_space_id=request.personal_space_id,
            executor_id=executor_id,
            public_executor_id=request.executor_id,
            payload_hash=payload_hash,
            display_name=request.display_name,
            executor_kind=request.executor_kind,
            capabilities=request.capabilities,
            models_json=json.dumps(
                [item.model_dump(mode='json') for item in request.advertised_models],
                sort_keys=True,
            ),
            global_priority=request.global_priority,
            health_required=request.health_required,
            test_source=request.test_source,
            cleanup_eligible=request.cleanup_eligible,
            timestamp=timestamp,
        )
        if not records:
            raise HTTPException(status_code=404, detail='personal space not found')
        row = records[0]
        raw = dict(row.get('executor') or {})
        if raw.get('payload_hash') not in {None, payload_hash}:
            raise HTTPException(
                status_code=409,
                detail='executor ID was registered with different input',
            )
        return self._executor_from_row(row, request.personal_space_id)

    async def authorize_project_agent_executor(
        self,
        actor: dict,
        request: ProjectAgentExecutorAuthorization,
    ) -> ProjectAgentExecutorRecord:
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        timestamp = now_utc()
        payload_hash = self._payload_hash(request)
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [permission:HAS_EXECUTOR_PERMISSION]->
                  (executor:FuliProjectAgentExecutor {
                    executor_id: $executor_id
                  })
            SET executor._authorization_write_lock = true
            REMOVE executor._authorization_write_lock
            WITH executor, permission,
                 coalesce(
                   permission.authorization_idempotency_key = $idempotency_key,
                   false
                 ) AS same_key
            WHERE (same_key
                   AND permission.authorization_payload_hash = $payload_hash)
               OR (NOT same_key AND (
                   $expected_revision IS NULL
                   OR coalesce(permission.revision, 0) = $expected_revision))
            FOREACH (_ IN CASE WHEN same_key THEN [] ELSE [1] END |
              SET permission.status = $permission_status,
                  permission.reason = $reason,
                  permission.authorization_idempotency_key = $idempotency_key,
                  permission.authorization_payload_hash = $payload_hash,
                  permission.revision = coalesce(permission.revision, 0) + 1,
                  permission.updated_at = $timestamp,
                  executor.permission_status = $permission_status,
                  executor.updated_at = $timestamp,
                  executor.revision = coalesce(executor.revision, 0) + 1
            )
            RETURN executor, permission
            ''',
            personal_space_id=request.personal_space_id,
            executor_id=request.executor_id,
            permission_status=request.status,
            reason=request.reason,
            expected_revision=request.expected_revision,
            idempotency_key=request.idempotency_key,
            payload_hash=payload_hash,
            timestamp=timestamp,
        )
        if not records:
            raise HTTPException(
                status_code=409,
                detail='executor permission is missing or revision is stale',
            )
        row = records[0]
        return self._executor_from_row(row, request.personal_space_id)

    async def upsert_project_agent_executor(
        self,
        actor: dict,
        request,
    ) -> ProjectAgentExecutorRecord:
        """Register or revision-guarded edit of a directory entry.

        ``register`` is intentionally create/idempotent.  Callers that expose
        an editable upsert must supply ``expected_revision`` so capability or
        model changes reset preflight and remain auditable.
        """

        if request.expected_revision is None:
            return await self.register_project_agent_executor(actor, request)
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        timestamp = now_utc()
        payload_hash = self._payload_hash(request)
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [permission:HAS_EXECUTOR_PERMISSION]->
                  (executor:FuliProjectAgentExecutor {
                    executor_id: $executor_id
                  })
            WHERE coalesce(executor.revision, 0) = $expected_revision
            SET executor.display_name = $display_name,
                executor.executor_kind = $executor_kind,
                executor.capabilities = $capabilities,
                executor.advertised_models_json = $models_json,
                executor.global_priority = $global_priority,
                executor.health_required = $health_required,
                executor.registration_status = 'registered',
                executor.preflight_status = 'not_run',
                executor.preflight_passed = false,
                executor.preflight_reason = 'directory entry changed; preflight required',
                executor.payload_hash = $payload_hash,
                executor.test_source = $test_source,
                executor.cleanup_eligible = $cleanup_eligible,
                executor.updated_at = $timestamp,
                executor.revision = coalesce(executor.revision, 0) + 1
            RETURN executor, permission
            ''',
            personal_space_id=request.personal_space_id,
            executor_id=request.executor_id,
            expected_revision=request.expected_revision,
            display_name=request.display_name,
            executor_kind=request.executor_kind,
            capabilities=request.capabilities,
            models_json=json.dumps(
                [item.model_dump(mode='json') for item in request.advertised_models],
                sort_keys=True,
            ),
            global_priority=request.global_priority,
            health_required=request.health_required,
            payload_hash=self._payload_hash(request),
            test_source=request.test_source,
            cleanup_eligible=request.cleanup_eligible,
            timestamp=timestamp,
        )
        if not records:
            raise HTTPException(status_code=409, detail='executor revision is stale or missing')
        return self._executor_from_row(records[0], request.personal_space_id)

    async def record_project_agent_executor_preflight(
        self,
        actor: dict,
        request: ProjectAgentExecutorPreflightReport,
    ) -> ProjectAgentExecutorRecord:
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        timestamp = now_utc()
        payload_hash = self._payload_hash(request)
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [permission:HAS_EXECUTOR_PERMISSION]->
                  (executor:FuliProjectAgentExecutor {
                    executor_id: $executor_id
                  })
            SET executor._preflight_write_lock = true
            REMOVE executor._preflight_write_lock
            WITH executor, permission,
                 coalesce(
                   executor.preflight_idempotency_key = $idempotency_key,
                   false
                 ) AS same_key
            WITH executor, permission, same_key,
                 (
                   (same_key
                    AND executor.preflight_payload_hash = $payload_hash)
                   OR (
                     NOT same_key
                     AND (
                       executor.preflight_at IS NULL
                       OR executor.preflight_at < $checked_at
                     )
                   )
                 ) AS accepted
            FOREACH (_ IN CASE
              WHEN accepted AND NOT same_key THEN [1] ELSE [] END |
              SET executor.preflight_status = $preflight_status,
                  executor.preflight_passed = $preflight_passed,
                  executor.preflight_reason = $reason,
                  executor.preflight_at = $checked_at,
                  executor.capabilities = $capabilities,
                  executor.available_models_json = $models_json,
                  executor.workspace_permission = $workspace_permission,
                  executor.preflight_idempotency_key = $idempotency_key,
                  executor.preflight_payload_hash = $payload_hash,
                  executor.updated_at = $timestamp,
                  executor.revision = coalesce(executor.revision, 0) + 1
            )
            RETURN executor, permission, accepted
            ''',
            personal_space_id=request.personal_space_id,
            executor_id=request.executor_id,
            preflight_status=request.status,
            preflight_passed=request.status == 'passed',
            reason=request.reason,
            checked_at=request.checked_at,
            capabilities=request.capabilities,
            models_json=json.dumps(
                [item.model_dump(mode='json') for item in request.available_models],
                sort_keys=True,
            ),
            workspace_permission=request.workspace_permission,
            idempotency_key=request.idempotency_key,
            payload_hash=payload_hash,
            timestamp=timestamp,
        )
        if not records:
            raise HTTPException(status_code=404, detail='registered executor not found')
        if not records[0].get('accepted'):
            raise HTTPException(
                status_code=409,
                detail='executor preflight report is stale or its idempotency key was reused',
            )
        return self._executor_from_row(records[0], request.personal_space_id)

    async def record_project_agent_executor_health(
        self,
        actor: dict,
        request: ProjectAgentExecutorHealthReport,
    ) -> ProjectAgentExecutorRecord:
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        timestamp = now_utc()
        payload_hash = self._payload_hash(request)
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [permission:HAS_EXECUTOR_PERMISSION]->
                  (executor:FuliProjectAgentExecutor {
                    executor_id: $executor_id
                  })
            SET executor._health_write_lock = true
            REMOVE executor._health_write_lock
            WITH executor, permission,
                 coalesce(
                   executor.health_idempotency_key = $idempotency_key,
                   false
                 ) AS same_key
            WITH executor, permission, same_key,
                 (
                   (same_key AND executor.health_payload_hash = $payload_hash)
                   OR (
                     NOT same_key
                     AND (
                       executor.health_checked_at IS NULL
                       OR executor.health_checked_at < $checked_at
                     )
                   )
                 ) AS accepted
            FOREACH (_ IN CASE
              WHEN accepted AND NOT same_key THEN [1] ELSE [] END |
              SET executor.health_status = $health_status,
                  executor.health_reason = $reason,
                  executor.health_checked_at = $checked_at,
                  executor.health_idempotency_key = $idempotency_key,
                  executor.health_payload_hash = $payload_hash,
                  executor.updated_at = $timestamp,
                  executor.revision = coalesce(executor.revision, 0) + 1
            )
            RETURN executor, permission, accepted
            ''',
            personal_space_id=request.personal_space_id,
            executor_id=request.executor_id,
            health_status=request.status,
            reason=request.reason,
            checked_at=request.checked_at,
            idempotency_key=request.idempotency_key,
            payload_hash=payload_hash,
            timestamp=timestamp,
        )
        if not records:
            raise HTTPException(status_code=404, detail='registered executor not found')
        if not records[0].get('accepted'):
            raise HTTPException(
                status_code=409,
                detail='executor health report is stale or its idempotency key was reused',
            )
        return self._executor_from_row(records[0], request.personal_space_id)

    async def list_project_agent_executors(
        self,
        actor: dict,
        personal_space_id: str,
        *,
        capability: str | None = None,
        available_only: bool = False,
    ) -> list[ProjectAgentExecutorRecord]:
        self._require_personal()
        await self.authorize(actor, personal_space_id, 'reader')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [permission:HAS_EXECUTOR_PERMISSION]->
                  (executor:FuliProjectAgentExecutor)
            WHERE ($capability IS NULL OR any(item IN coalesce(executor.capabilities, [])
                                              WHERE toLower(item) CONTAINS toLower($capability)))
              AND ($available_only = false OR (
                executor.registration_status = 'registered'
                AND permission.status = 'authorized'
                AND executor.preflight_status = 'passed'
                AND coalesce(executor.workspace_permission, false) = true
                AND executor.health_status <> 'unhealthy'
                AND (
                  coalesce(executor.health_required, false) = false
                  OR executor.health_status = 'healthy'
                )
              ))
            RETURN executor, permission
            ORDER BY coalesce(executor.global_priority, 100), executor.executor_id
            ''',
            personal_space_id=personal_space_id,
            capability=capability,
            available_only=available_only,
            routing_='r',
        )
        return [
            self._executor_from_row(row, personal_space_id)
            for row in records
        ]

    async def get_project_agent_executor(
        self,
        actor: dict,
        personal_space_id: str,
        executor_id: str,
    ) -> ProjectAgentExecutorRecord:
        records = await self.list_project_agent_executors(actor, personal_space_id)
        for record in records:
            if record.executor_id == executor_id:
                return record
        raise HTTPException(status_code=404, detail='executor not found')

    async def archive_project_agent_executor(
        self,
        actor: dict,
        personal_space_id: str,
        executor_id: str,
        *,
        reason: str,
    ) -> ProjectAgentExecutorRecord:
        """Disable one scoped executor without erasing its audit history."""

        self._require_personal()
        await self.authorize(actor, personal_space_id, 'maintainer')
        reason = reason.strip()
        if not reason:
            raise HTTPException(status_code=422, detail='executor archive reason is required')
        timestamp = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [permission:HAS_EXECUTOR_PERMISSION]->
                  (executor:FuliProjectAgentExecutor {
                    executor_id: $executor_id
                  })
            SET executor.registration_status = 'disabled',
                executor.permission_status = 'revoked',
                executor.archive_reason = $reason,
                executor.archived_at = $timestamp,
                executor.updated_at = $timestamp,
                executor.revision = coalesce(executor.revision, 0) + 1,
                permission.status = 'revoked',
                permission.reason = $reason,
                permission.updated_at = $timestamp,
                permission.revision = coalesce(permission.revision, 0) + 1
            RETURN executor, permission
            ''',
            personal_space_id=personal_space_id,
            executor_id=executor_id,
            reason=reason,
            timestamp=timestamp,
        )
        if not records:
            raise HTTPException(status_code=404, detail='executor not found')
        return self._executor_from_row(records[0], personal_space_id)

    async def update_project_agent_executor_priority(
        self,
        actor: dict,
        request,
    ) -> ProjectAgentExecutorRecord:
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        timestamp = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [permission:HAS_EXECUTOR_PERMISSION]->
                  (executor:FuliProjectAgentExecutor {
                    executor_id: $executor_id
                  })
            WHERE coalesce(executor.revision, 0) = $expected_revision
            SET executor.global_priority = $global_priority,
                executor.priority_reason = $reason,
                executor.priority_updated_at = $timestamp,
                executor.updated_at = $timestamp,
                executor.revision = coalesce(executor.revision, 0) + 1
            RETURN executor, permission
            ''',
            personal_space_id=request.personal_space_id,
            executor_id=request.executor_id,
            expected_revision=request.expected_revision,
            global_priority=request.global_priority,
            reason=request.reason,
            timestamp=timestamp,
        )
        if not records:
            raise HTTPException(status_code=409, detail='executor priority revision is stale')
        return self._executor_from_row(records[0], request.personal_space_id)

    async def create_project_agent_executor_routing_rule(
        self,
        actor: dict,
        request: ProjectAgentExecutorRoutingRuleCreate,
    ) -> ProjectAgentExecutorRoutingRuleRecord:
        self._require_personal()
        await self._authorize_rule_scope(actor, request)
        rule_id = stable_uuid(
            self.settings.provider_id,
            'project-agent-executor-rule',
            request.scope,
            request.personal_space_id or '',
            request.personal_project_id or '',
            request.task_id or '',
            request.idempotency_key,
        )
        payload_hash = self._payload_hash(request)
        timestamp = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MERGE (rule:FuliProjectAgentExecutorRoutingRule {id: $rule_id})
            ON CREATE SET rule.rule_id = $rule_id,
                          rule.payload_hash = $payload_hash,
                          rule.scope = $scope,
                          rule.personal_space_id = $personal_space_id,
                          rule.personal_project_id = $personal_project_id,
                          rule.task_id = $task_id,
                          rule.work_kind = $work_kind,
                          rule.required_capabilities = $required_capabilities,
                          rule.executor_ids = $executor_ids,
                          rule.model_strategy_json = $model_strategy_json,
                          rule.priority = $priority,
                          rule.reason = $reason,
                          rule.status = 'active',
                          rule.revision = 0,
                          rule.created_at = $timestamp,
                          rule.updated_at = $timestamp
            RETURN rule
            ''',
            rule_id=rule_id,
            payload_hash=payload_hash,
            scope=request.scope,
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            task_id=request.task_id,
            work_kind=request.work_kind,
            required_capabilities=request.required_capabilities,
            executor_ids=request.executor_ids,
            model_strategy_json=(
                request.model_strategy.model_dump_json()
                if request.model_strategy else None
            ),
            priority=request.priority,
            reason=request.reason,
            timestamp=timestamp,
        )
        if not records:
            raise HTTPException(status_code=404, detail='routing rule was not stored')
        raw = dict(records[0].get('rule') or {})
        if raw.get('payload_hash') not in {None, payload_hash}:
            raise HTTPException(
                status_code=409,
                detail='routing rule idempotency key was reused with different input',
            )
        return self._routing_rule_from_raw(raw)

    async def list_project_agent_executor_routing_rules(
        self,
        actor: dict,
        *,
        personal_space_id: str | None = None,
        personal_project_id: str | None = None,
        task_id: str | None = None,
        scope: ProjectAgentExecutorScope | None = None,
        status: str | None = None,
    ) -> list[ProjectAgentExecutorRoutingRuleRecord]:
        self._require_personal()
        if personal_space_id:
            await self.authorize(actor, personal_space_id, 'reader')
            if personal_project_id:
                space = await self.authorize(actor, personal_space_id, 'reader')
                await authorize_personal_project(
                    self,
                    actor,
                    space,
                    personal_project_id,
                )
        elif not actor.get('provider_admin'):
            raise HTTPException(status_code=403, detail='provider administrator required')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (rule:FuliProjectAgentExecutorRoutingRule)
            WHERE ($personal_space_id IS NULL
                   OR rule.personal_space_id = $personal_space_id
                   OR rule.scope = 'global')
              AND ($personal_project_id IS NULL
                   OR rule.personal_project_id = $personal_project_id)
              AND ($task_id IS NULL OR rule.task_id = $task_id)
              AND ($scope IS NULL OR rule.scope = $scope)
              AND ($status IS NULL OR rule.status = $status)
            RETURN rule
            ORDER BY CASE rule.scope
                       WHEN 'task' THEN 3
                       WHEN 'project' THEN 2
                       WHEN 'space' THEN 1
                       ELSE 0 END DESC,
                     coalesce(rule.priority, 100), rule.rule_id
            ''',
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            task_id=task_id,
            scope=scope,
            status=status,
            routing_='r',
        )
        return [self._routing_rule_from_raw(dict(row['rule'])) for row in records]

    async def update_project_agent_executor_routing_rule(
        self,
        actor: dict,
        request: ProjectAgentExecutorRoutingRuleUpdate,
    ) -> ProjectAgentExecutorRoutingRuleRecord:
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        timestamp = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (rule:FuliProjectAgentExecutorRoutingRule {
              rule_id: $rule_id,
              personal_space_id: $personal_space_id
            })
            WHERE coalesce(rule.revision, 0) = $expected_revision
            SET rule.status = $status,
                rule.update_reason = $reason,
                rule.updated_at = $timestamp,
                rule.revision = coalesce(rule.revision, 0) + 1
            RETURN rule
            ''',
            personal_space_id=request.personal_space_id,
            rule_id=request.rule_id,
            expected_revision=request.expected_revision,
            status=request.status,
            reason=request.reason,
            timestamp=timestamp,
        )
        if not records:
            raise HTTPException(status_code=409, detail='routing rule revision is stale')
        return self._routing_rule_from_raw(dict(records[0]['rule']))

    async def get_project_agent_executor_routing_rule(
        self,
        actor: dict,
        personal_space_id: str,
        rule_id: str,
    ) -> ProjectAgentExecutorRoutingRuleRecord:
        rules = await self.list_project_agent_executor_routing_rules(
            actor,
            personal_space_id=personal_space_id,
        )
        for rule in rules:
            if rule.rule_id == rule_id:
                return rule
        raise HTTPException(status_code=404, detail='executor routing rule not found')

    async def archive_project_agent_executor_routing_rule(
        self,
        actor: dict,
        personal_space_id: str,
        rule_id: str,
        *,
        reason: str,
    ) -> ProjectAgentExecutorRoutingRuleRecord:
        """End a scoped rule while retaining every past routing decision."""

        self._require_personal()
        await self.authorize(actor, personal_space_id, 'maintainer')
        reason = reason.strip()
        if not reason:
            raise HTTPException(status_code=422, detail='routing rule archive reason is required')
        timestamp = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (rule:FuliProjectAgentExecutorRoutingRule {
              rule_id: $rule_id,
              personal_space_id: $personal_space_id
            })
            SET rule.status = 'ended',
                rule.update_reason = $reason,
                rule.ended_at = $timestamp,
                rule.updated_at = $timestamp,
                rule.revision = coalesce(rule.revision, 0) + 1
            RETURN rule
            ''',
            personal_space_id=personal_space_id,
            rule_id=rule_id,
            reason=reason,
            timestamp=timestamp,
        )
        if not records:
            raise HTTPException(status_code=404, detail='executor routing rule not found')
        return self._routing_rule_from_raw(dict(records[0]['rule']))

    async def record_project_agent_executor_actual(
        self,
        actor: dict,
        request: ProjectAgentExecutorActualReport,
    ) -> ProjectAgentExecutorActualReport:
        """Persist the executor/model actually observed by a Task Run."""

        async with query_store_transaction(self) as scoped:
            return await scoped._record_project_agent_executor_actual(actor, request)

    async def _record_project_agent_executor_actual(self, actor, request):
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        await authorize_personal_project(
            self,
            actor,
            space,
            request.personal_project_id,
        )
        # Explicit ordering also applies when activity already owns the task lock.
        # Profile/preflight/revocation writers cannot change validated state until
        # this observation and its projection commit together.
        for target, match in (
            ('task', '''MATCH (task:FuliProjectAgentTask {
                personal_space_id: $personal_space_id,
                personal_project_id: $personal_project_id, task_id: $task_id
            })'''),
            ('agent', '''MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})
                -[:HAS_PROJECT_AGENT_IDENTITY]->
                (agent:FuliProjectAgent {agent_id: $agent_id})'''),
            ('executor', '''MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})
                -[:HAS_EXECUTOR_PERMISSION]->
                (executor:FuliProjectAgentExecutor {executor_id: $executor_id})'''),
            ('permission', '''MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})
                -[permission:HAS_EXECUTOR_PERMISSION]->
                (:FuliProjectAgentExecutor {executor_id: $executor_id})'''),
        ):
            await self.runtime.driver.execute_query(
                f'{match} SET {target}._actual_write_lock = true '
                f'REMOVE {target}._actual_write_lock RETURN count(*) AS locked',
                personal_space_id=request.personal_space_id,
                personal_project_id=request.personal_project_id,
                task_id=request.task_id,
                agent_id=request.agent_id,
                executor_id=request.executor_id,
            )
        validation_records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (task:FuliProjectAgentTask {
              personal_space_id: $personal_space_id,
              personal_project_id: $personal_project_id,
              task_id: $task_id
            })
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [permission:HAS_EXECUTOR_PERMISSION]->
                  (executor:FuliProjectAgentExecutor {
                    executor_id: $executor_id
                  })
            MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: $agent_id})
            MATCH (task)-[:HAS_PARTICIPANT]->(agent)
            WHERE permission.status = 'authorized'
              AND executor.registration_status = 'registered'
              AND executor.preflight_status = 'passed'
              AND coalesce(executor.workspace_permission, false) = true
            RETURN task, agent, executor, permission
            ''',
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            task_id=request.task_id,
            executor_id=request.executor_id,
            agent_id=request.agent_id,
            routing_='r',
        )
        if not validation_records:
            raise HTTPException(
                status_code=409,
                detail='actual executor is not registered, authorized, and preflighted',
            )
        validation_row = validation_records[0]
        profile_json = dict(validation_row.get('agent') or {}).get('profile_json')
        if profile_json:
            profile = ProjectAgentProfile.model_validate_json(profile_json)
            if (request.source_application or 'other') not in profile.allowed_clients:
                raise HTTPException(
                    status_code=403,
                    detail='project Agent is not available to this source client',
                )
        task_raw = dict(validation_row.get('task') or {})
        current_projection_exists = any(task_raw.get(key) for key in (
            'actual_executor_id', 'actual_model_provider', 'actual_model'))
        current_actual_at = native_datetime(task_raw.get('actual_occurred_at'))
        if current_projection_exists and current_actual_at is None and task_raw.get('actual_run_id'):
            previous, _, _ = await self.runtime.driver.execute_query('''
                MATCH (task:FuliProjectAgentTask {
                  personal_space_id: $personal_space_id,
                  personal_project_id: $personal_project_id, task_id: $task_id
                })-[:HAS_EXECUTOR_OBSERVATION]->(observation {
                  run_id: $actual_run_id
                })
                WHERE observation.executor_id = task.actual_executor_id
                  AND observation.provider = task.actual_model_provider
                  AND observation.model = task.actual_model
                  AND observation.agent_id = $agent_id
                  AND (
                    observation.projection_applied = true
                    OR (
                      observation.projection_applied IS NULL
                      AND observation.projection_considered IS NULL
                    )
                  )
                RETURN observation.occurred_at AS occurred_at
                ''', personal_space_id=request.personal_space_id,
                personal_project_id=request.personal_project_id,
                task_id=request.task_id, actual_run_id=task_raw['actual_run_id'],
                agent_id=request.agent_id, routing_='r')
            previous_times = [
                native_datetime(row.get('occurred_at')) for row in previous
            ]
            if previous_times and all(
                value is not None
                and callable(getattr(value, 'utcoffset', None))
                and value.utcoffset() is not None
                for value in previous_times
            ):
                current_actual_at = max(previous_times)
        projection_allowed = not current_projection_exists
        if current_projection_exists and current_actual_at is not None:
            projection_allowed = (
                current_actual_at.utcoffset() is not None
                and request.occurred_at >= current_actual_at
            )
        task_strategy = ProjectAgentModelStrategy()
        task_strategy_json = task_raw.get('effective_model_strategy_json')
        if task_strategy_json:
            try:
                task_strategy = ProjectAgentModelStrategy.model_validate_json(
                    task_strategy_json
                )
            except Exception as exc:
                raise HTTPException(
                    status_code=409,
                    detail='task model strategy is invalid and must be repaired',
                ) from exc
        if project_agent_model_strategy_key(
            request.model_strategy
        ) != project_agent_model_strategy_key(task_strategy):
            raise HTTPException(
                status_code=409,
                detail='actual model strategy does not match the task strategy',
            )
        executor_record = self._executor_from_row(
            validation_row,
            request.personal_space_id,
        )
        reported_model = next(
            (
                item
                for item in executor_record.available_models
                if item.available
                and item.provider == request.provider
                and item.model == request.model
            ),
            None,
        )
        if reported_model is None:
            raise HTTPException(
                status_code=409,
                detail='actual model was not reported by the latest passed preflight',
            )
        if self._select_model([reported_model], task_strategy) is None:
            raise HTTPException(
                status_code=409,
                detail='actual model does not satisfy the task model strategy',
            )
        if (
            executor_record.health_status == 'unhealthy'
            or (
                executor_record.health_required
                and executor_record.health_status != 'healthy'
            )
        ):
            raise HTTPException(
                status_code=409,
                detail='actual executor health does not permit execution',
            )
        agent_policy = self._policy_from_agent(
            dict(validation_row.get('agent') or {})
        )
        effective_policy = agent_policy
        task_policy_json = task_raw.get('executor_policy_json')
        if task_policy_json:
            try:
                effective_policy = ProjectAgentExecutorPolicy.model_validate_json(
                    task_policy_json
                )
            except Exception as exc:
                raise HTTPException(
                    status_code=409,
                    detail='task executor policy is invalid and must be repaired',
                ) from exc
        # An Agent lock remains authoritative even if an older Task projection
        # contains a different effective policy.
        if agent_policy.mode == 'locked':
            effective_policy = agent_policy
        if (
            effective_policy.mode == 'locked'
            and request.executor_id not in effective_policy.locked_executor_ids
        ):
            raise HTTPException(
                status_code=409,
                detail='actual executor is outside the effective locked allow-list',
            )
        selected_executor_id = task_raw.get('selected_executor_id')
        if (
            selected_executor_id
            and selected_executor_id != request.executor_id
            and not request.fallback_reason
        ):
            raise HTTPException(
                status_code=409,
                detail='actual executor differs from the selection without a fallback reason',
            )
        observation_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            'project-agent-executor-observation',
            request.task_id,
            request.run_id,
            request.idempotency_key,
        )
        payload_hash = self._payload_hash(request)
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (task:FuliProjectAgentTask {
              personal_space_id: $personal_space_id,
              personal_project_id: $personal_project_id,
              task_id: $task_id
            })
            MERGE (observation:FuliProjectAgentExecutorObservation {
              id: $observation_id
            })
            ON CREATE SET observation.observation_id = $observation_id,
                          observation.payload_hash = $payload_hash,
                          observation.task_id = $task_id,
                          observation.run_id = $run_id,
                          observation.executor_id = $executor_id,
                          observation.provider = $provider,
                          observation.model = $model,
                          observation.agent_id = $agent_id,
                          observation.model_strategy_json = $model_strategy_json,
                          observation.model_strategy_source = $model_strategy_source,
                          observation.matched_rule_id = $matched_rule_id,
                          observation.fallback_reason = $fallback_reason,
                          observation.occurred_at = $occurred_at,
                          observation.source_application = $source_application,
                          observation.source_session_id = $source_session_id
            WITH task, observation,
                 observation.payload_hash = $payload_hash AS payload_matches,
                 coalesce(observation.projection_considered,
                          observation.projection_applied, false) = false
                   AS projection_pending
            FOREACH (_ IN CASE
              WHEN payload_matches AND projection_pending THEN [1] ELSE [] END |
              MERGE (task)-[:HAS_EXECUTOR_OBSERVATION]->(observation)
              SET observation.projection_considered = true
            )
            FOREACH (_ IN CASE
              WHEN payload_matches AND projection_pending
                AND $projection_allowed
              THEN [1] ELSE [] END |
              SET task.actual_executor_id = $executor_id,
                  task.actual_run_id = $run_id,
                  task.actual_model_provider = $provider,
                  task.actual_model = $model,
                  task.actual_model_strategy_json = $model_strategy_json,
                  task.actual_model_strategy_source = $model_strategy_source,
                  task.matched_executor_rule_id = $matched_rule_id,
                  task.executor_fallback_reason = $fallback_reason,
                  task.actual_occurred_at = $occurred_at,
                  task.updated_at = CASE
                    WHEN task.updated_at IS NULL OR task.updated_at < $occurred_at
                    THEN $occurred_at ELSE task.updated_at END,
                  observation.projection_applied = true
            )
            RETURN task, observation, payload_matches
            ''',
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            task_id=request.task_id,
            observation_id=observation_id,
            payload_hash=payload_hash,
            run_id=request.run_id,
            agent_id=request.agent_id,
            executor_id=request.executor_id,
            provider=request.provider,
            model=request.model,
            model_strategy_json=request.model_strategy.model_dump_json(),
            model_strategy_source=request.model_strategy_source,
            matched_rule_id=request.matched_rule_id,
            fallback_reason=request.fallback_reason,
            occurred_at=request.occurred_at,
            source_application=request.source_application,
            source_session_id=request.source_session_id,
            projection_allowed=projection_allowed,
        )
        if not records:
            raise HTTPException(status_code=404, detail='project Agent task not found')
        row = records[0]
        observation = dict(row.get('observation') or {})
        payload_matches = row.get(
            'payload_matches',
            observation.get('payload_hash') == payload_hash,
        )
        if payload_matches is not True:
            raise HTTPException(
                status_code=409,
                detail='executor observation idempotency key was reused',
            )
        return request

    async def archive_test_project_agents(
        self,
        actor: dict,
        personal_space_id: str,
        *,
        test_source: str,
    ) -> int:
        """Archive only explicitly marked test identities; never delete them."""

        self._require_personal()
        await self.authorize(actor, personal_space_id, 'maintainer')
        if not test_source.strip():
            raise HTTPException(status_code=422, detail='test source is required')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent)
            WHERE agent.test_source = $test_source
              AND coalesce(agent.cleanup_eligible, false) = true
            WITH space, agent
            ORDER BY agent.agent_id
            SET agent._task_lifecycle_lock = true
            REMOVE agent._task_lifecycle_lock
            WITH space, agent
            OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask)-
                  [participant:HAS_PARTICIPANT]->(agent)
            WITH space, agent, collect(DISTINCT {
              task_id: task.task_id,
              status: participant.status
            }) AS tasks
            WITH space, agent, [item IN tasks
                         WHERE item.task_id IS NOT NULL
                           AND item.status IN [
                             'awaiting_recruitment', 'queued', 'running',
                             'paused', 'blocked', 'awaiting_review'
                           ]] AS open_tasks
            WHERE agent.status = 'archived' OR size(open_tasks) = 0
            WITH space, agent,
                 coalesce(agent.status, 'active') <> 'archived'
                   AS newly_archived
            SET agent.status = 'archived',
                agent.updated_at = $updated_at,
                agent.archive_reason = coalesce(agent.archive_reason,
                                                'test cleanup'),
                agent.archived_at = coalesce(agent.archived_at, $updated_at)
            WITH space, agent, newly_archived
            OPTIONAL MATCH (space)-[:CONTAINS_PROJECT]->
                           (:FuliPersonalProject)-
                           [:HAS_PROJECT_AGENT_ASSIGNMENT]->
                           (assignment:FuliProjectAgentAssignment)-
                           [:ASSIGNED_AGENT]->(agent)
            WHERE assignment.status = 'active'
            SET assignment.status = 'ended',
                assignment.end_reason = 'test Agent archived',
                assignment.ended_at = $updated_at,
                assignment.updated_at = $updated_at,
                assignment.revision = coalesce(assignment.revision, 0) + 1
            RETURN count(DISTINCT CASE WHEN newly_archived THEN agent END)
                     AS archived_count
            ''',
            personal_space_id=personal_space_id,
            test_source=test_source,
            updated_at=now_utc(),
        )
        return int(records[0].get('archived_count', 0)) if records else 0

    # Short aliases make the mixin convenient for provider/facade adapters and
    # keep the public naming independent from the eventual HTTP route names.
    register_executor = register_project_agent_executor
    upsert_executor = upsert_project_agent_executor
    authorize_executor = authorize_project_agent_executor
    record_executor_preflight = record_project_agent_executor_preflight
    record_executor_health = record_project_agent_executor_health
    list_executors = list_project_agent_executors
    get_executor = get_project_agent_executor
    archive_executor = archive_project_agent_executor
    update_executor_priority = update_project_agent_executor_priority
    create_executor_routing_rule = create_project_agent_executor_routing_rule
    list_executor_routing_rules = list_project_agent_executor_routing_rules
    update_executor_routing_rule = update_project_agent_executor_routing_rule
    get_executor_routing_rule = get_project_agent_executor_routing_rule
    archive_executor_routing_rule = archive_project_agent_executor_routing_rule
    record_task_executor_actual = record_project_agent_executor_actual

    @staticmethod
    def _payload_hash(value: Any) -> str:
        if hasattr(value, 'model_dump'):
            payload = value.model_dump(mode='json', exclude={'idempotency_key'})
        else:
            payload = value
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(',', ':'), default=str).encode()
        ).hexdigest()

    async def _authorize_rule_scope(
        self,
        actor: dict,
        request: ProjectAgentExecutorRoutingRuleCreate,
    ) -> None:
        if request.scope == 'global':
            if not actor.get('provider_admin'):
                raise HTTPException(
                    status_code=403,
                    detail='provider administrator required for global executor rules',
                )
            return
        if not request.personal_space_id:
            raise HTTPException(status_code=422, detail='routing rule space is required')
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        if request.personal_project_id:
            await authorize_personal_project(
                self,
                actor,
                space,
                request.personal_project_id,
            )

    @staticmethod
    def _json_list(value: Any) -> list[Any]:
        if value is None:
            return []
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except (TypeError, ValueError):
                return []
        return list(value) if isinstance(value, (list, tuple)) else []

    @classmethod
    def _models_from_raw(cls, value: Any) -> list[ProjectAgentExecutorModelRecord]:
        result = []
        for item in cls._json_list(value):
            try:
                result.append(ProjectAgentExecutorModelRecord.model_validate(item))
            except Exception:
                continue
        return result

    @classmethod
    def _executor_from_row(
        cls,
        row: dict,
        personal_space_id: str,
    ) -> ProjectAgentExecutorRecord:
        raw = dict(row.get('executor') or row)
        permission = dict(row.get('permission') or {})
        available_models = cls._models_from_raw(
            raw.get('available_models_json')
            or raw.get('advertised_models_json')
            or raw.get('available_models')
        )
        permission_status = (
            permission.get('status')
            or raw.get('permission_status')
            or 'pending'
        )
        workspace_permission = raw.get(
            'workspace_permission',
            permission_status == 'authorized',
        )
        registered_at = native_datetime(raw.get('registered_at')) or now_utc()
        updated_at = native_datetime(raw.get('updated_at')) or registered_at
        return ProjectAgentExecutorRecord(
            executor_id=raw.get('executor_id') or raw.get('public_executor_id') or raw.get('id'),
            display_name=raw.get('display_name') or raw.get('executor_id') or 'executor',
            executor_kind=raw.get('executor_kind') or 'external',
            registration_status=raw.get('registration_status') or 'registered',
            permission_status=permission_status,
            preflight_status=raw.get('preflight_status') or 'not_run',
            health_status=raw.get('health_status') or 'unknown',
            health_required=bool(raw.get('health_required', False)),
            workspace_permission=bool(workspace_permission),
            capabilities=list(raw.get('capabilities') or []),
            available_models=available_models,
            global_priority=int(raw.get('global_priority', 100)),
            revision=int(raw.get('revision', 0)),
            permission_revision=int(permission.get('revision', 0)),
            preflight_at=native_datetime(raw.get('preflight_at')),
            health_checked_at=native_datetime(raw.get('health_checked_at')),
            registered_at=registered_at,
            updated_at=updated_at,
            test_source=raw.get('test_source'),
            cleanup_eligible=bool(raw.get('cleanup_eligible', False)),
        )

    @staticmethod
    def _routing_rule_from_raw(raw: dict) -> ProjectAgentExecutorRoutingRuleRecord:
        model_strategy_json = raw.get('model_strategy_json')
        model_strategy = None
        if model_strategy_json:
            try:
                model_strategy = ProjectAgentModelStrategy.model_validate_json(
                    model_strategy_json
                )
            except Exception:
                model_strategy = None
        return ProjectAgentExecutorRoutingRuleRecord(
            rule_id=raw.get('rule_id') or raw.get('id'),
            scope=raw.get('scope') or 'global',
            personal_space_id=raw.get('personal_space_id'),
            personal_project_id=raw.get('personal_project_id'),
            task_id=raw.get('task_id'),
            work_kind=raw['work_kind'],
            required_capabilities=list(raw.get('required_capabilities') or []),
            executor_ids=list(raw.get('executor_ids') or []),
            model_strategy=model_strategy,
            priority=int(raw.get('priority', 100)),
            reason=raw.get('reason') or 'routing rule',
            idempotency_key=raw.get('idempotency_key') or 'stored-rule-key',
            status=raw.get('status') or 'active',
            revision=int(raw.get('revision', 0)),
            created_at=native_datetime(raw.get('created_at')) or now_utc(),
            updated_at=native_datetime(raw.get('updated_at'))
            or native_datetime(raw.get('created_at'))
            or now_utc(),
        )
