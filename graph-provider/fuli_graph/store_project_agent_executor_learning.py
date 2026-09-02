"""Auditable, decayed executor outcome evidence and learning aggregates."""

from __future__ import annotations

import json
import math
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import HTTPException

from .personal_project_access import authorize_personal_project
from .project_agent_executor_models import (
    ProjectAgentExecutorEvidenceContribution,
    ProjectAgentExecutorEvidenceIgnore,
    ProjectAgentExecutorOutcomeAggregate,
    ProjectAgentExecutorOutcomeEvidenceCreate,
    ProjectAgentExecutorOutcomeEvidenceRecord,
    ProjectAgentExecutorOutcomeReset,
    project_agent_model_strategy_key,
)
from .project_agent_models import ProjectAgentModelStrategy
from .provider_values import native_datetime, now_utc, stable_uuid
from .store_transactions import query_store_transaction


_TERMINAL_NEUTRAL = {'cancelled'}
_DEFAULT_HALF_LIFE_DAYS = 30.0
_DEFAULT_RECENT_DAYS = 7
_MINIMUM_EVIDENCE_SAMPLES = 3


def project_agent_executor_outcome_bucket_id(
    provider_id: str,
    personal_space_id: str,
    personal_project_id: str,
    work_kind: str,
    agent_id: str,
    executor_id: str,
    model_strategy_key: str,
    *,
    bucket_kind: str,
) -> str:
    """Return the provider- and space-scoped identity for a learning cache."""

    if bucket_kind not in {'aggregate', 'reset'}:
        raise ValueError('unsupported Project Agent executor outcome bucket kind')
    return stable_uuid(
        provider_id,
        personal_space_id,
        f'project-agent-executor-outcome-{bucket_kind}',
        personal_project_id,
        work_kind,
        agent_id,
        executor_id,
        model_strategy_key,
    )


class StoreProjectAgentExecutorLearning:
    """Persist explainable evidence without overriding explicit user policy."""

    @staticmethod
    def _learning_scope(request):
        return {key: getattr(request, key) for key in (
            'personal_space_id', 'personal_project_id', 'work_kind',
            'agent_id', 'executor_id', 'model_strategy')}

    @asynccontextmanager
    async def _learning_bucket_transaction(self, **scope):
        """Serialize a bucket before reading its evidence and commit together."""
        strategy_key = project_agent_model_strategy_key(scope['model_strategy'])
        bucket_id = project_agent_executor_outcome_bucket_id(
            self.settings.provider_id, scope['personal_space_id'],
            scope['personal_project_id'], scope['work_kind'], scope['agent_id'],
            scope['executor_id'], strategy_key, bucket_kind='aggregate')
        async with query_store_transaction(self) as scoped:
            await scoped.runtime.driver.execute_query('''
                MERGE (bucket:FuliProjectAgentExecutorOutcomeAggregate {id: $bucket_id})
                ON CREATE SET bucket.aggregate_id = $bucket_id,
                              bucket.personal_space_id = $personal_space_id,
                              bucket.personal_project_id = $personal_project_id,
                              bucket.work_kind = $work_kind,
                              bucket.agent_id = $agent_id,
                              bucket.executor_id = $executor_id,
                              bucket.model_strategy_key = $model_strategy_key
                SET bucket._write_lock = true
                REMOVE bucket._write_lock
                ''', bucket_id=bucket_id, model_strategy_key=strategy_key,
                **{key: value for key, value in scope.items() if key != 'model_strategy'})
            yield scoped

    async def record_project_agent_executor_outcome_evidence(
        self,
        actor: dict,
        request: ProjectAgentExecutorOutcomeEvidenceCreate,
    ) -> ProjectAgentExecutorOutcomeEvidenceRecord:
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        await authorize_personal_project(
            self,
            actor,
            space,
            request.personal_project_id,
        )
        async with query_store_transaction(self) as scoped:
            # Relationship writes below also lock the task. Match the activity
            # path's task -> bucket order instead of introducing its inverse.
            await scoped.runtime.driver.execute_query('''
                MATCH (task:FuliProjectAgentTask {
                  personal_space_id: $personal_space_id,
                  personal_project_id: $personal_project_id, task_id: $task_id
                })
                SET task._outcome_write_lock = true
                REMOVE task._outcome_write_lock
                ''', **{key: getattr(request, key) for key in (
                    'personal_space_id', 'personal_project_id', 'task_id')})
            await scoped._validate_outcome_execution(request)
            async with scoped._learning_bucket_transaction(**self._learning_scope(request)) as bucket:
                return await bucket._record_outcome_evidence(actor, request)

    async def _validate_outcome_execution(self, request):
        """Bind credit to recorded work, not a caller-chosen learning bucket.

        External test/user references remain caller-supplied assertions. Only
        system terminal evidence is derived from a persisted task event.
        Historical execution remains usable after an executor is revoked.
        """
        rows, _, _ = await self.runtime.driver.execute_query('''
            MATCH (task:FuliProjectAgentTask {
              personal_space_id: $personal_space_id,
              personal_project_id: $personal_project_id, task_id: $task_id
            })-[:HAS_PARTICIPANT]->(agent:FuliProjectAgent {agent_id: $agent_id})
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})
                  -[:HAS_PROJECT_AGENT_IDENTITY]->(agent)
            OPTIONAL MATCH (task)-[:HAS_EXECUTOR_OBSERVATION]->
                          (observation:FuliProjectAgentExecutorObservation {
                            agent_id: $agent_id, executor_id: $executor_id
                          })
            WHERE $run_id IS NULL OR observation.run_id = $run_id
            WITH task, collect(DISTINCT observation) AS observations
            OPTIONAL MATCH (task)-[:HAS_TASK_EVENT]->(event:FuliProjectAgentTaskEvent {
                event_id: $run_id, agent_id: $agent_id, actual_executor_id: $executor_id
            })
            RETURN task, observations, event
            ''', **{key: getattr(request, key) for key in (
                'personal_space_id', 'personal_project_id', 'task_id',
                'agent_id', 'executor_id', 'run_id')}, routing_='r')
        if not rows:
            raise HTTPException(status_code=409, detail='outcome Agent is not a task participant')
        row = rows[0]
        task = dict(row['task'])
        strategy_key = project_agent_model_strategy_key(request.model_strategy)

        def matches_strategy(raw):
            strategy = ProjectAgentModelStrategy.model_validate_json(raw or '{}')
            return project_agent_model_strategy_key(strategy) == strategy_key

        if (task.get('work_kind') != request.work_kind
                or not matches_strategy(task.get('effective_model_strategy_json'))):
            raise HTTPException(status_code=409, detail='outcome work kind or strategy does not match the task')
        observations = [dict(value) for value in row.get('observations') or []]
        if not any(matches_strategy(value.get('model_strategy_json')) for value in observations):
            raise HTTPException(status_code=409, detail='outcome requires a matching recorded execution')
        if request.evidence_kind == 'terminal_outcome':
            event = dict(row.get('event') or {})
            terminal_status = event.get('status')
            if terminal_status not in {'completed', 'failed', 'cancelled'}:
                terminal_status = event.get('worker_status')
            if (not event or terminal_status != request.terminal_outcome
                    or request.reference_ids != [request.run_id]
                    or request.idempotency_key != f'terminal:{request.run_id}'
                    or request.occurred_at != native_datetime(event.get('created_at'))):
                raise HTTPException(status_code=409, detail='terminal outcome must match its canonical task event')

    async def _record_outcome_evidence(self, actor, request):
        evidence_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            'project-agent-executor-evidence',
            request.task_id,
            request.run_id or '',
            request.executor_id,
            project_agent_model_strategy_key(request.model_strategy),
            request.idempotency_key,
        )
        strategy_key = project_agent_model_strategy_key(request.model_strategy)
        payload_hash = self._payload_hash(request)
        timestamp = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (task:FuliProjectAgentTask {
              personal_space_id: $personal_space_id,
              personal_project_id: $personal_project_id,
              task_id: $task_id
            })
            MERGE (evidence:FuliProjectAgentExecutorOutcomeEvidence {
              id: $evidence_id
            })
            ON CREATE SET evidence.evidence_id = $evidence_id,
                          evidence.payload_hash = $payload_hash,
                          evidence.idempotency_key = $idempotency_key,
                          evidence.personal_space_id = $personal_space_id,
                          evidence.personal_project_id = $personal_project_id,
                          evidence.work_kind = $work_kind,
                          evidence.agent_id = $agent_id,
                          evidence.executor_id = $executor_id,
                          evidence.task_id = $task_id,
                          evidence.run_id = $run_id,
                          evidence.model_strategy_json = $model_strategy_json,
                          evidence.model_strategy_key = $model_strategy_key,
                          evidence.evidence_kind = $evidence_kind,
                          evidence.source = $source,
                          evidence.terminal_outcome = $terminal_outcome,
                          evidence.rating = $rating,
                          evidence.reference_ids = $reference_ids,
                          evidence.note = $note,
                          evidence.occurred_at = $occurred_at,
                          evidence.ignored = false,
                          evidence.created_at = $created_at
            MERGE (task)-[:HAS_EXECUTOR_OUTCOME_EVIDENCE]->(evidence)
            RETURN evidence
            ''',
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            work_kind=request.work_kind,
            agent_id=request.agent_id,
            executor_id=request.executor_id,
            task_id=request.task_id,
            run_id=request.run_id,
            evidence_id=evidence_id,
            payload_hash=payload_hash,
            idempotency_key=request.idempotency_key,
            model_strategy_json=request.model_strategy.model_dump_json(),
            model_strategy_key=strategy_key,
            evidence_kind=request.evidence_kind,
            source=request.source,
            terminal_outcome=request.terminal_outcome,
            rating=request.rating,
            reference_ids=request.reference_ids,
            note=request.note,
            occurred_at=request.occurred_at,
            created_at=timestamp,
        )
        if not records:
            raise HTTPException(status_code=404, detail='project Agent task not found')
        raw = dict(records[0].get('evidence') or {})
        if raw.get('payload_hash') not in {None, payload_hash}:
            raise HTTPException(
                status_code=409,
                detail='outcome evidence idempotency key was reused',
            )
        evidence = self._outcome_evidence_from_raw(raw, request)
        await self.aggregate_project_agent_executor_outcomes(
            actor,
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            work_kind=request.work_kind,
            agent_id=request.agent_id,
            executor_id=request.executor_id,
            model_strategy=request.model_strategy,
        )
        return evidence

    async def list_project_agent_executor_outcome_evidence(
        self,
        actor: dict,
        personal_space_id: str,
        personal_project_id: str,
        *,
        work_kind: str | None = None,
        executor_id: str | None = None,
        agent_id: str | None = None,
        model_strategy_key: str | None = None,
        include_ignored: bool = False,
    ) -> list[ProjectAgentExecutorOutcomeEvidenceRecord]:
        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'reader')
        await authorize_personal_project(
            self,
            actor,
            space,
            personal_project_id,
        )
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (evidence:FuliProjectAgentExecutorOutcomeEvidence {
              personal_space_id: $personal_space_id,
              personal_project_id: $personal_project_id
            })
            WHERE ($work_kind IS NULL OR evidence.work_kind = $work_kind)
              AND ($executor_id IS NULL OR evidence.executor_id = $executor_id)
              AND ($agent_id IS NULL OR evidence.agent_id = $agent_id)
              AND ($model_strategy_key IS NULL
                   OR evidence.model_strategy_key = $model_strategy_key)
              AND ($include_ignored = true OR coalesce(evidence.ignored, false) = false)
            RETURN evidence
            ORDER BY evidence.occurred_at DESC, evidence.evidence_id
            ''',
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            work_kind=work_kind,
            executor_id=executor_id,
            agent_id=agent_id,
            model_strategy_key=model_strategy_key,
            include_ignored=include_ignored,
            routing_='r',
        )
        evidence = [
            self._outcome_evidence_from_raw(dict(row['evidence']))
            for row in records
            if row.get('evidence')
        ]
        if model_strategy_key is not None:
            evidence = [
                item
                for item in evidence
                if item.model_strategy_key == model_strategy_key
            ]
        return evidence

    async def list_project_agent_executor_outcome_aggregates(
        self,
        actor: dict,
        personal_space_id: str,
        *,
        personal_project_id: str | None = None,
        work_kind: str | None = None,
        agent_id: str | None = None,
        executor_id: str | None = None,
        model_strategy_key: str | None = None,
    ) -> list[ProjectAgentExecutorOutcomeAggregate]:
        """List durable learning buckets without combining strategies."""

        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'reader')
        if personal_project_id is not None:
            await authorize_personal_project(
                self,
                actor,
                space,
                personal_project_id,
            )
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (aggregate:FuliProjectAgentExecutorOutcomeAggregate {
              personal_space_id: $personal_space_id
            })
            WHERE ($personal_project_id IS NULL
                   OR aggregate.personal_project_id = $personal_project_id)
              AND ($work_kind IS NULL OR aggregate.work_kind = $work_kind)
              AND ($agent_id IS NULL OR aggregate.agent_id = $agent_id)
              AND ($executor_id IS NULL OR aggregate.executor_id = $executor_id)
              AND ($model_strategy_key IS NULL
                   OR aggregate.model_strategy_key = $model_strategy_key)
            RETURN aggregate
            ORDER BY aggregate.as_of DESC, aggregate.executor_id
            ''',
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            work_kind=work_kind,
            agent_id=agent_id,
            executor_id=executor_id,
            model_strategy_key=model_strategy_key,
            routing_='r',
        )
        aggregates: list[ProjectAgentExecutorOutcomeAggregate] = []
        for row in records:
            raw = dict(row.get('aggregate') or {})
            aggregate_json = raw.get('aggregate_json')
            if aggregate_json:
                try:
                    raw.update(json.loads(aggregate_json))
                except (TypeError, ValueError):
                    pass
            # Storage identities are intentionally internal: the public model
            # remains the provider-neutral bucket contract.
            raw.pop('id', None)
            raw.pop('aggregate_id', None)
            raw.pop('aggregate_json', None)
            if not raw.get('model_strategy_key'):
                strategy_value = raw.get('model_strategy')
                if isinstance(strategy_value, str):
                    try:
                        strategy_value = json.loads(strategy_value)
                    except (TypeError, ValueError):
                        strategy_value = None
                try:
                    strategy = ProjectAgentModelStrategy.model_validate(
                        strategy_value or {}
                    )
                except Exception:
                    strategy = ProjectAgentModelStrategy()
                raw['model_strategy'] = strategy
                raw['model_strategy_key'] = project_agent_model_strategy_key(strategy)
            try:
                aggregate = ProjectAgentExecutorOutcomeAggregate.model_validate(raw)
            except Exception:
                # An incomplete legacy node cannot be presented as an audited
                # learning bucket; it remains available for migration/repair.
                continue
            if (
                model_strategy_key is None
                or aggregate.model_strategy_key == model_strategy_key
            ):
                aggregates.append(aggregate)
        return aggregates

    async def ignore_project_agent_executor_outcome_evidence(
        self,
        actor: dict,
        request: ProjectAgentExecutorEvidenceIgnore,
    ) -> ProjectAgentExecutorOutcomeEvidenceRecord:
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        await authorize_personal_project(
            self,
            actor,
            space,
            request.personal_project_id,
        )
        records, _, _ = await self.runtime.driver.execute_query('''
            MATCH (evidence:FuliProjectAgentExecutorOutcomeEvidence {
              personal_space_id: $personal_space_id, personal_project_id: $personal_project_id,
              agent_id: $agent_id, evidence_id: $evidence_id
            })
            RETURN evidence
            ''', **{key: getattr(request, key) for key in (
                'personal_space_id', 'personal_project_id', 'agent_id', 'evidence_id')})
        if not records:
            raise HTTPException(status_code=409, detail='outcome evidence is missing')
        evidence = self._outcome_evidence_from_raw(dict(records[0]['evidence']))
        async with self._learning_bucket_transaction(**self._learning_scope(evidence)) as scoped:
            return await scoped._ignore_outcome_evidence(actor, request)

    async def _ignore_outcome_evidence(self, actor, request):
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (evidence:FuliProjectAgentExecutorOutcomeEvidence {
              personal_space_id: $personal_space_id,
              personal_project_id: $personal_project_id,
              agent_id: $agent_id,
              evidence_id: $evidence_id
            })
            WHERE evidence.ignore_idempotency_key IS NULL
               OR (evidence.ignore_idempotency_key = $idempotency_key
                   AND (evidence.ignore_payload_hash = $payload_hash
                     OR (evidence.ignore_payload_hash IS NULL
                         AND evidence.ignored_reason = $reason)))
            SET evidence.ignored = true,
                evidence.ignored_reason = $reason,
                evidence.ignore_idempotency_key = $idempotency_key,
                evidence.ignore_payload_hash = $payload_hash,
                evidence.ignored_at = coalesce(evidence.ignored_at, $updated_at)
            RETURN evidence
            ''',
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            agent_id=request.agent_id,
            evidence_id=request.evidence_id,
            reason=request.reason,
            idempotency_key=request.idempotency_key,
            payload_hash=self._payload_hash(request),
            updated_at=now_utc(),
        )
        if not records:
            raise HTTPException(
                status_code=409,
                detail='outcome evidence is missing or ignore idempotency key was reused',
            )
        evidence = self._outcome_evidence_from_raw(dict(records[0]['evidence']))
        # Ignoring evidence changes the effective sample immediately.  Rebuild
        # only this strategy bucket so a later route can use the new signal
        # without requiring a separate UI aggregation action.
        await self.aggregate_project_agent_executor_outcomes(
            actor,
            personal_space_id=evidence.personal_space_id,
            personal_project_id=evidence.personal_project_id,
            work_kind=evidence.work_kind,
            agent_id=evidence.agent_id,
            executor_id=evidence.executor_id,
            model_strategy=evidence.model_strategy,
        )
        return evidence

    async def reset_project_agent_executor_outcomes(
        self,
        actor: dict,
        request: ProjectAgentExecutorOutcomeReset,
    ) -> ProjectAgentExecutorOutcomeAggregate | None:
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        await authorize_personal_project(
            self,
            actor,
            space,
            request.personal_project_id,
        )
        async with self._learning_bucket_transaction(**self._learning_scope(request)) as scoped:
            return await scoped._reset_outcomes(actor, request)

    async def _reset_outcomes(self, actor, request):
        strategy_key = project_agent_model_strategy_key(request.model_strategy)
        reset_id = project_agent_executor_outcome_bucket_id(
            self.settings.provider_id,
            request.personal_space_id,
            request.personal_project_id,
            request.work_kind,
            request.agent_id,
            request.executor_id,
            strategy_key,
            bucket_kind='reset',
        )
        payload_hash = self._payload_hash(request)
        previous, _, _ = await self.runtime.driver.execute_query('''
            MATCH (reset:FuliProjectAgentExecutorOutcomeReset {id: $reset_id})
            RETURN reset.reset_at AS previous_reset_at
            ''', reset_id=reset_id, routing_='r')
        previous_time = native_datetime(previous[0]['previous_reset_at']) if previous else None
        replace_unknown_timezone = previous_time is not None and previous_time.utcoffset() is None
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MERGE (reset:FuliProjectAgentExecutorOutcomeReset {
              id: $reset_id
            })
            ON CREATE SET reset.reset_id = $reset_id,
                          reset.personal_space_id = $personal_space_id,
                          reset.personal_project_id = $personal_project_id,
                          reset.work_kind = $work_kind,
                          reset.agent_id = $agent_id,
                          reset.executor_id = $executor_id,
                          reset.model_strategy_key = $model_strategy_key,
                          reset.payload_hash = $payload_hash,
                          reset.idempotency_key = $idempotency_key
            WITH reset,
                 reset.payload_hash IS NULL
                 OR reset.payload_hash = $payload_hash
                 OR (
                   reset.idempotency_key <> $idempotency_key
                   AND (reset.reset_at IS NULL OR $replace_unknown_timezone
                        OR reset.reset_at < $reset_at)
                 ) AS accepted
            WHERE accepted
            SET reset.reset_at = $reset_at,
                reset.reason = $reason,
                reset.model_strategy_json = $model_strategy_json,
                reset.model_strategy_key = $model_strategy_key,
                reset.payload_hash = $payload_hash,
                reset.idempotency_key = $idempotency_key,
                reset.updated_at = $reset_at
            RETURN reset
            ''',
            reset_id=reset_id,
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            work_kind=request.work_kind,
            agent_id=request.agent_id,
            executor_id=request.executor_id,
            model_strategy_json=request.model_strategy.model_dump_json(),
            model_strategy_key=strategy_key,
            payload_hash=payload_hash,
            reset_at=request.reset_at,
            replace_unknown_timezone=replace_unknown_timezone,
            reason=request.reason,
            idempotency_key=request.idempotency_key,
        )
        if not records:
            raise HTTPException(
                status_code=409,
                detail='outcome reset idempotency key was reused with different input',
            )
        return await self.aggregate_project_agent_executor_outcomes(
            actor,
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            work_kind=request.work_kind,
            agent_id=request.agent_id,
            executor_id=request.executor_id,
            model_strategy=request.model_strategy,
        )

    async def aggregate_project_agent_executor_outcomes(
        self,
        actor: dict,
        *,
        personal_space_id: str,
        personal_project_id: str,
        work_kind: str,
        executor_id: str,
        agent_id: str,
        model_strategy: ProjectAgentModelStrategy | None = None,
        as_of: datetime | None = None,
        decay_half_life_days: float = _DEFAULT_HALF_LIFE_DAYS,
    ) -> ProjectAgentExecutorOutcomeAggregate:
        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'reader')
        await authorize_personal_project(
            self,
            actor,
            space,
            personal_project_id,
        )
        if decay_half_life_days <= 0:
            raise HTTPException(status_code=422, detail='decay half-life must be positive')
        strategy = model_strategy or ProjectAgentModelStrategy()
        async with self._learning_bucket_transaction(
            personal_space_id=personal_space_id, personal_project_id=personal_project_id,
            work_kind=work_kind, executor_id=executor_id, agent_id=agent_id,
            model_strategy=strategy,
        ) as scoped:
            return await scoped._aggregate_outcomes(
                personal_space_id=personal_space_id, personal_project_id=personal_project_id,
                work_kind=work_kind, executor_id=executor_id, agent_id=agent_id,
                strategy=strategy, as_of=as_of, decay_half_life_days=decay_half_life_days)

    async def _aggregate_outcomes(self, *, personal_space_id, personal_project_id,
                                  work_kind, executor_id, agent_id, strategy,
                                  as_of, decay_half_life_days):
        strategy_key = project_agent_model_strategy_key(strategy)
        reset_id = project_agent_executor_outcome_bucket_id(
            self.settings.provider_id,
            personal_space_id,
            personal_project_id,
            work_kind,
            agent_id,
            executor_id,
            strategy_key,
            bucket_kind='reset',
        )
        aggregate_id = project_agent_executor_outcome_bucket_id(
            self.settings.provider_id,
            personal_space_id,
            personal_project_id,
            work_kind,
            agent_id,
            executor_id,
            strategy_key,
            bucket_kind='aggregate',
        )
        reset_records, _, _ = await self.runtime.driver.execute_query(
            '''
            OPTIONAL MATCH (reset:FuliProjectAgentExecutorOutcomeReset {
              id: $reset_id
            })
            RETURN reset
            ''',
            reset_id=reset_id,
            routing_='r',
        )
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (evidence:FuliProjectAgentExecutorOutcomeEvidence {
              personal_space_id: $personal_space_id,
              personal_project_id: $personal_project_id,
              work_kind: $work_kind,
              agent_id: $agent_id,
              executor_id: $executor_id,
              model_strategy_key: $model_strategy_key
            })
            RETURN evidence
            ''',
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            work_kind=work_kind,
            agent_id=agent_id,
            executor_id=executor_id,
            model_strategy_key=strategy_key,
            routing_='r',
        )
        current = as_of or now_utc()
        if current.utcoffset() is None:
            raise HTTPException(status_code=422, detail='aggregation time requires a timezone')
        validation_warnings = []
        reset_at = None
        for row in reset_records:
            reset_raw = row.get('reset')
            if not reset_raw:
                continue
            candidate = native_datetime(dict(reset_raw).get('reset_at'))
            if candidate and candidate.utcoffset() is None:
                validation_warnings.append('reset_timestamp_timezone_missing')
            if candidate and (reset_at is None or (not validation_warnings and candidate > reset_at)):
                reset_at = candidate
        evidence_rows = []
        for row in records:
            raw = row.get('evidence')
            if raw:
                raw = dict(raw)
                raw_key = raw.get('model_strategy_key')
                if not raw_key:
                    evidence_strategy_json = raw.get('model_strategy_json')
                    if evidence_strategy_json:
                        try:
                            evidence_strategy = ProjectAgentModelStrategy.model_validate_json(
                                evidence_strategy_json
                            )
                        except Exception:
                            evidence_strategy = ProjectAgentModelStrategy()
                    else:
                        evidence_strategy = ProjectAgentModelStrategy()
                    raw_key = project_agent_model_strategy_key(evidence_strategy)
                if raw_key == strategy_key:
                    evidence_rows.append(raw)
                    if (not raw.get('ignored')
                            and native_datetime(raw.get('occurred_at')).utcoffset() is None):
                        validation_warnings.append(
                            f'evidence_timestamp_timezone_missing:{raw.get("evidence_id") or raw.get("id")}')
        # Older requests accepted local datetimes. Never guess their timezone or
        # let one invalid value prevent subsequent ignore/reset repairs. Expose
        # the history, but keep the entire bucket neutral until it is usable.
        evidence = [
            self._outcome_evidence_from_raw(raw)
            for raw in evidence_rows
            if not raw.get('ignored')
            and (
                validation_warnings
                or reset_at is None
                or native_datetime(raw.get('occurred_at')) > reset_at
            )
        ]
        contributions: list[ProjectAgentExecutorEvidenceContribution] = []
        success_count = 0
        failure_count = 0
        rework_count = 0
        rating_values: list[int] = []
        recent_count = 0
        weighted_success = 0.0
        weighted_failure = 0.0
        evidence_refs: set[str] = set()
        for item in evidence:
            occurred = item.occurred_at
            age = None if validation_warnings else max(0.0, (current - occurred).total_seconds() / 86400)
            weight = 0.0 if age is None else math.pow(0.5, age / decay_half_life_days)
            if age is not None and age <= _DEFAULT_RECENT_DAYS:
                recent_count += 1
            evidence_refs.update(item.reference_ids)
            if item.task_id:
                evidence_refs.add(f'task:{item.task_id}')
            if item.run_id:
                evidence_refs.add(f'run:{item.run_id}')
            signal, value = ('neutral', 0.0) if validation_warnings else self._evidence_signal(item)
            if signal == 'success':
                success_count += 1
                weighted_success += weight * value
            elif signal == 'failure':
                failure_count += 1
                weighted_failure += weight * value
            elif signal == 'rework':
                rework_count += 1
                weighted_failure += weight * value
            elif signal == 'rating' and item.rating is not None:
                rating_values.append(item.rating)
                weighted_success += weight * max(0.0, (item.rating - 3) / 2)
                weighted_failure += weight * max(0.0, (3 - item.rating) / 2)
            contributions.append(
                ProjectAgentExecutorEvidenceContribution(
                    evidence_id=item.evidence_id,
                    evidence_kind=item.evidence_kind,
                    signal=signal,
                    value=value,
                    decay_weight=weight,
                    occurred_at=occurred,
                    reference_ids=item.reference_ids,
                )
            )
        sample_count = len(evidence)
        aggregate = ProjectAgentExecutorOutcomeAggregate(
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            work_kind=work_kind,
            agent_id=agent_id,
            executor_id=executor_id,
            model_strategy=strategy,
            model_strategy_key=strategy_key,
            sample_count=sample_count,
            recent_count=recent_count,
            success_count=success_count,
            rework_count=rework_count,
            failure_count=failure_count,
            rating_count=len(rating_values),
            average_rating=(sum(rating_values) / len(rating_values)) if rating_values else None,
            neutral_due_to_insufficient_evidence=bool(validation_warnings) or sample_count < _MINIMUM_EVIDENCE_SAMPLES,
            ignored=bool(validation_warnings),
            reset_at=reset_at,
            as_of=current,
            decay_half_life_days=decay_half_life_days,
            weighted_success=weighted_success,
            weighted_failure=weighted_failure,
            evidence_refs=sorted(evidence_refs),
            evidence_contributions=contributions,
            validation_warnings=validation_warnings,
        )
        await self.runtime.driver.execute_query(
            '''
            MERGE (aggregate:FuliProjectAgentExecutorOutcomeAggregate {
              id: $aggregate_id
            })
            ON CREATE SET aggregate.aggregate_id = $aggregate_id,
                          aggregate.personal_space_id = $personal_space_id,
                          aggregate.personal_project_id = $personal_project_id,
                          aggregate.work_kind = $work_kind,
                          aggregate.agent_id = $agent_id,
                          aggregate.executor_id = $executor_id,
                          aggregate.model_strategy_key = $model_strategy_key
            WITH aggregate
            WHERE aggregate.as_of IS NULL OR aggregate.as_of <= $as_of
            SET aggregate.aggregate_json = $aggregate_json,
                aggregate.sample_count = $sample_count,
                aggregate.recent_count = $recent_count,
                aggregate.success_count = $success_count,
                aggregate.rework_count = $rework_count,
                aggregate.failure_count = $failure_count,
                aggregate.rating_count = $rating_count,
                aggregate.average_rating = $average_rating,
                aggregate.neutral_due_to_insufficient_evidence =
                  $neutral_due_to_insufficient_evidence,
                aggregate.reset_at = $reset_at,
                aggregate.as_of = $as_of,
                aggregate.decay_half_life_days = $decay_half_life_days,
                aggregate.weighted_success = $weighted_success,
                aggregate.weighted_failure = $weighted_failure,
                aggregate.evidence_refs = $evidence_refs
            ''',
            aggregate_id=aggregate_id,
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            work_kind=work_kind,
            agent_id=agent_id,
            executor_id=executor_id,
            model_strategy_key=strategy_key,
            aggregate_json=aggregate.model_dump_json(),
            sample_count=aggregate.sample_count,
            recent_count=aggregate.recent_count,
            success_count=aggregate.success_count,
            rework_count=aggregate.rework_count,
            failure_count=aggregate.failure_count,
            rating_count=aggregate.rating_count,
            average_rating=aggregate.average_rating,
            neutral_due_to_insufficient_evidence=(
                aggregate.neutral_due_to_insufficient_evidence
            ),
            reset_at=aggregate.reset_at,
            as_of=aggregate.as_of,
            decay_half_life_days=aggregate.decay_half_life_days,
            weighted_success=aggregate.weighted_success,
            weighted_failure=aggregate.weighted_failure,
            evidence_refs=aggregate.evidence_refs,
        )
        return aggregate

    @staticmethod
    def _outcome_evidence_from_raw(
        raw: dict,
        fallback: ProjectAgentExecutorOutcomeEvidenceCreate | None = None,
    ) -> ProjectAgentExecutorOutcomeEvidenceRecord:
        model_strategy_json = raw.get('model_strategy_json')
        if model_strategy_json:
            try:
                strategy = ProjectAgentModelStrategy.model_validate_json(model_strategy_json)
            except Exception:
                strategy = ProjectAgentModelStrategy()
        elif fallback:
            strategy = fallback.model_strategy
        else:
            strategy = ProjectAgentModelStrategy()
        strategy_key = raw.get('model_strategy_key')
        if not strategy_key:
            strategy_key = project_agent_model_strategy_key(strategy)
        return ProjectAgentExecutorOutcomeEvidenceRecord(
            personal_space_id=raw.get('personal_space_id') or (fallback.personal_space_id if fallback else ''),
            personal_project_id=raw.get('personal_project_id') or (fallback.personal_project_id if fallback else ''),
            work_kind=raw.get('work_kind') or (fallback.work_kind if fallback else ''),
            agent_id=raw.get('agent_id') or (fallback.agent_id if fallback else ''),
            executor_id=raw.get('executor_id') or (fallback.executor_id if fallback else ''),
            task_id=raw.get('task_id') or (fallback.task_id if fallback else ''),
            run_id=raw.get('run_id') or (fallback.run_id if fallback else None),
            model_strategy=strategy,
            model_strategy_key=strategy_key,
            evidence_kind=raw.get('evidence_kind') or (fallback.evidence_kind if fallback else 'terminal_outcome'),
            source=raw.get('source') or (fallback.source if fallback else 'system_terminal'),
            terminal_outcome=raw.get('terminal_outcome') or (fallback.terminal_outcome if fallback else None),
            rating=raw.get('rating') if raw.get('rating') is not None else (fallback.rating if fallback else None),
            reference_ids=list(raw.get('reference_ids') or (fallback.reference_ids if fallback else [])),
            note=raw.get('note') or (fallback.note if fallback else None),
            idempotency_key=raw.get('idempotency_key') or (fallback.idempotency_key if fallback else 'stored-evidence-key'),
            occurred_at=native_datetime(raw.get('occurred_at')) or (fallback.occurred_at if fallback else now_utc()),
            evidence_id=raw.get('evidence_id') or raw.get('id') or 'stored-evidence',
            ignored=bool(raw.get('ignored', False)),
            ignored_reason=raw.get('ignored_reason'),
            created_at=native_datetime(raw.get('created_at')) or now_utc(),
        )

    @staticmethod
    def _evidence_signal(
        item: ProjectAgentExecutorOutcomeEvidenceRecord,
    ) -> tuple[str, float]:
        if item.evidence_kind in {'explicit_rating'}:
            return 'rating', 1.0
        if item.evidence_kind in {
            'terminal_outcome',
            'explicit_praise',
            'test_passed',
            'acceptance_passed',
        }:
            if item.evidence_kind == 'terminal_outcome':
                if item.terminal_outcome in _TERMINAL_NEUTRAL:
                    return 'neutral', 0.0
                if item.terminal_outcome == 'failed':
                    return 'failure', 1.0
            return 'success', 1.0
        if item.evidence_kind in {'rework_requested'}:
            return 'rework', 1.0
        return 'failure', 1.0

    record_executor_outcome_evidence = record_project_agent_executor_outcome_evidence
    list_executor_outcome_evidence = list_project_agent_executor_outcome_evidence
    list_executor_outcome_aggregates = list_project_agent_executor_outcome_aggregates
    ignore_executor_outcome_evidence = ignore_project_agent_executor_outcome_evidence
    reset_executor_outcomes = reset_project_agent_executor_outcomes
    aggregate_executor_outcomes = aggregate_project_agent_executor_outcomes
