"""Policy-aware executor selection and its durable audit decision."""

from __future__ import annotations

import json

from fastapi import HTTPException

from .personal_project_access import authorize_personal_project
from .project_agent_executor_models import (
    ProjectAgentExecutorModelRecord,
    ProjectAgentExecutorRecord,
    ProjectAgentExecutorRoutingRuleRecord,
    ProjectAgentExecutorScope,
    ProjectAgentExecutorSelection,
    project_agent_model_strategy_key,
)
from .project_agent_models import ProjectAgentExecutorPolicy, ProjectAgentModelStrategy
from .provider_values import now_utc, stable_uuid


_RULE_SCOPE_RANK = {'global': 0, 'space': 1, 'project': 2, 'task': 3}


class StoreProjectAgentExecutorRouting:
    """Resolve registered executors without owning directory mutations."""

    async def resolve_project_agent_executor(
        self,
        actor: dict,
        *,
        personal_space_id: str,
        personal_project_id: str,
        task_id: str,
        agent_id: str,
        work_kind: str,
        required_capabilities: list[str] | None = None,
        model_strategy: ProjectAgentModelStrategy | None = None,
        task_override: ProjectAgentExecutorPolicy | dict | None = None,
        executor_policy: ProjectAgentExecutorPolicy | dict | None = None,
        assignment_id: str | None = None,
        model_strategy_source: str | None = None,
        idempotency_key: str | None = None,
    ) -> ProjectAgentExecutorSelection:
        """Resolve and persist an executor decision without creating a worker.

        Rule precedence is task > project > space > global.  An empty rule
        directory is valid and means there is no work-kind mapping; flexible
        selection then uses only the global executor priority.  A locked Agent
        policy is evaluated first and never falls back outside its allow-list.
        """

        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'maintainer')
        await authorize_personal_project(
            self,
            actor,
            space,
            personal_project_id,
        )
        required = [item.strip() for item in (required_capabilities or [])]
        if any(not item for item in required):
            raise HTTPException(status_code=422, detail='required capabilities cannot be blank')
        agent_rows, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent {agent_id: $agent_id})
            OPTIONAL MATCH (space)-[:CONTAINS_PROJECT]->
                  (:FuliPersonalProject {project_id: $personal_project_id})-
                  [:HAS_PROJECT_AGENT_ASSIGNMENT]->
                  (assignment:FuliProjectAgentAssignment)-[:ASSIGNED_AGENT]->(agent)
            WHERE assignment.status = 'active'
              AND ($assignment_id IS NULL OR assignment.assignment_id = $assignment_id)
              AND ($assignment_id IS NOT NULL
                   OR $work_kind IN coalesce(assignment.work_kinds, []))
            RETURN agent, assignment
            ''',
            personal_space_id=personal_space_id,
            agent_id=agent_id,
            personal_project_id=personal_project_id,
            assignment_id=assignment_id,
            work_kind=work_kind,
            routing_='r',
        )
        if not agent_rows:
            raise HTTPException(status_code=404, detail='Agent not found')
        agent_raw = dict(agent_rows[0].get('agent') or {})
        assignment_raw = dict(agent_rows[0].get('assignment') or {})
        agent_policy = self._policy_from_agent(agent_raw)
        assignment_policy = self._policy_from_assignment(assignment_raw)
        override = task_override if task_override is not None else executor_policy
        # An Agent-level lock is the highest authority.  It cannot be
        # bypassed by a Task, Assignment, or routing-rule override.
        if agent_policy.mode == 'locked':
            policy = agent_policy
            resolved_strategy_source = model_strategy_source or 'agent'
        elif override is not None:
            policy = (
                override
                if isinstance(override, ProjectAgentExecutorPolicy)
                else ProjectAgentExecutorPolicy.model_validate(override)
            )
            resolved_strategy_source = model_strategy_source or 'task'
        elif assignment_policy is not None:
            policy = assignment_policy
            resolved_strategy_source = model_strategy_source or 'assignment'
        else:
            policy = agent_policy
            resolved_strategy_source = model_strategy_source or 'agent'
        strategy = model_strategy or self._strategy_from_agent(agent_raw)
        strategy_key = project_agent_model_strategy_key(strategy)
        rules_records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (rule:FuliProjectAgentExecutorRoutingRule)
            WHERE rule.status = 'active'
              AND rule.work_kind = $work_kind
              AND (rule.scope = 'global'
                   OR (rule.scope = 'space'
                       AND rule.personal_space_id = $personal_space_id)
                   OR (rule.scope = 'project'
                       AND rule.personal_space_id = $personal_space_id
                       AND rule.personal_project_id = $personal_project_id)
                   OR (rule.scope = 'task'
                       AND rule.personal_space_id = $personal_space_id
                       AND rule.personal_project_id = $personal_project_id
                       AND rule.task_id = $task_id))
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
            work_kind=work_kind,
            routing_='r',
        )
        requested_capabilities = {item.casefold() for item in required}
        rules = [
            rule
            for rule in (
                self._routing_rule_from_raw(dict(row['rule']))
                for row in rules_records
                if row.get('rule')
            )
            if {
                item.casefold() for item in rule.required_capabilities
            }.issubset(requested_capabilities)
        ]
        top_scope = max((_RULE_SCOPE_RANK[item.scope] for item in rules), default=None)
        top_rules = [
            item for item in rules
            if top_scope is not None and _RULE_SCOPE_RANK[item.scope] == top_scope
        ]
        executor_records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [permission:HAS_EXECUTOR_PERMISSION]->
                  (executor:FuliProjectAgentExecutor)
            OPTIONAL MATCH (aggregate:FuliProjectAgentExecutorOutcomeAggregate {
              personal_space_id: $personal_space_id,
              personal_project_id: $personal_project_id,
              work_kind: $work_kind,
              agent_id: $agent_id,
              model_strategy_key: $model_strategy_key,
              executor_id: executor.executor_id
            })
            RETURN executor, permission, aggregate
            ORDER BY coalesce(executor.global_priority, 100), executor.executor_id
            ''',
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            work_kind=work_kind,
            agent_id=agent_id,
            model_strategy_key=strategy_key,
            routing_='r',
        )
        executor_map = {
            str(row.get('executor', {}).get('executor_id')): self._executor_from_row(
                row,
                personal_space_id,
            )
            for row in executor_records
            if row.get('executor')
        }
        aggregate_map = {}
        for row in executor_records:
            if not row.get('executor') or not row.get('aggregate'):
                continue
            aggregate_raw = dict(row['aggregate'])
            aggregate_json = aggregate_raw.get('aggregate_json')
            if aggregate_json:
                try:
                    aggregate_raw.update(json.loads(aggregate_json))
                except (TypeError, ValueError):
                    pass
            aggregate_key = aggregate_raw.get('model_strategy_key')
            if not aggregate_key:
                aggregate_strategy_json = aggregate_raw.get('model_strategy_json')
                if aggregate_strategy_json:
                    try:
                        aggregate_strategy = ProjectAgentModelStrategy.model_validate_json(
                            aggregate_strategy_json
                        )
                    except Exception:
                        aggregate_strategy = ProjectAgentModelStrategy()
                else:
                    aggregate_strategy = ProjectAgentModelStrategy()
                aggregate_key = project_agent_model_strategy_key(aggregate_strategy)
            # The Cypher pattern is strategy-scoped.  Keep the defensive
            # filter as well so a compatible driver/cache cannot merge a
            # different strategy bucket into this route decision.
            if aggregate_key != strategy_key:
                continue
            aggregate_map[str(row['executor'].get('executor_id'))] = aggregate_raw
        candidates, candidate_rule_id, candidate_scope = self._candidate_ids(
            policy,
            executor_map,
            top_rules,
        )
        if policy.mode == 'flexible' and top_rules and not policy.preferred_executor_ids:
            candidates = self._tie_break_same_level_candidates(
                candidates,
                top_rules,
                executor_map,
                aggregate_map,
            )
        selected = None
        selected_model = None
        unavailable_reasons: dict[str, str] = {}
        for candidate_id in candidates:
            executor = executor_map.get(candidate_id)
            if executor is None:
                unavailable_reasons[candidate_id] = 'executor is not registered in this space'
                continue
            reason = self._executor_unavailable_reason(
                executor,
                required,
                strategy,
            )
            if reason:
                unavailable_reasons[candidate_id] = reason
                continue
            selected = executor
            selected_model = self._select_model(executor.available_models, strategy)
            break
        timestamp = now_utc()
        selection_id = stable_uuid(
            self.settings.provider_id,
            personal_space_id,
            'project-agent-executor-selection',
            task_id,
            idempotency_key or task_id,
        )
        first_candidate = candidates[0] if candidates else None
        if selected:
            used_fallback = bool(first_candidate and first_candidate != selected.executor_id)
            if policy.mode == 'locked':
                status = 'selected'
                fallback_outcome = 'not_needed'
                fallback_reason = None
            elif used_fallback:
                status = 'fallback'
                fallback_outcome = (
                    'same_rule_candidate'
                    if candidate_scope is not None and candidate_scope != 'global'
                    else 'global_priority'
                )
                fallback_reason = (
                    f'{first_candidate} unavailable: '
                    f'{unavailable_reasons.get(first_candidate, "not selected")}'
                )
            else:
                status = 'selected'
                fallback_outcome = 'not_needed'
                fallback_reason = None
            selection_reason = (
                'locked executor allow-list'
                if policy.mode == 'locked'
                else 'explicit executor preference'
                if policy.preferred_executor_ids
                else 'same-level routing rule'
                if candidate_rule_id
                else 'global executor priority'
            )
            blocked_reason = None
            selected_id = selected.executor_id
            selected_provider = selected_model.provider if selected_model else None
            selected_model_name = selected_model.model if selected_model else None
        else:
            # A flexible policy may try every eligible candidate, but an empty
            # result is still a durable block for the Task.  Returning
            # ``unavailable`` here would let the task store leave a task
            # queued with no executable owner.
            status = 'blocked'
            fallback_outcome = (
                'blocked_locked' if policy.mode == 'locked' else 'blocked_no_candidate'
            )
            fallback_reason = None
            selection_reason = (
                'locked allow-list unavailable'
                if policy.mode == 'locked'
                else 'no usable executor'
            )
            blocked_reason = '; '.join(
                f'{key}: {value}' for key, value in unavailable_reasons.items()
            ) or 'no registered executor candidate'
            selected_id = None
            selected_provider = None
            selected_model_name = None
        selection = ProjectAgentExecutorSelection(
            selection_id=selection_id,
            task_id=task_id,
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            agent_id=agent_id,
            status=status,
            outcome=status,
            selected_executor_id=selected_id,
            executor_id=selected_id,
            selected_provider=selected_provider,
            selected_model=selected_model_name,
            matched_rule_id=candidate_rule_id,
            rule_id=candidate_rule_id,
            matched_rule_scope=candidate_scope,
            candidate_executor_ids=candidates,
            selection_reason=selection_reason,
            reason=selection_reason,
            fallback_outcome=fallback_outcome,
            fallback_from_executor_id=(
                first_candidate
                if selected and first_candidate != selected_id
                else None
            ),
            fallback_reason=fallback_reason,
            blocked_reason=blocked_reason,
            model_strategy=strategy,
            model_strategy_key=strategy_key,
            model_strategy_source=resolved_strategy_source,
            executor_policy=policy,
            idempotency_key=idempotency_key,
            payload_fingerprint=self._payload_hash({
                'task_id': task_id,
                'agent_id': agent_id,
                'work_kind': work_kind,
                'required_capabilities': required,
                'model_strategy': strategy.model_dump(mode='json'),
                'policy': policy.model_dump(mode='json'),
            }),
            created_at=timestamp,
        )
        await self._persist_executor_selection(selection)
        return selection

    async def _persist_executor_selection(
        self,
        selection: ProjectAgentExecutorSelection,
    ) -> None:
        raw = selection.model_dump(mode='json')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MERGE (decision:FuliProjectAgentExecutorDecision {
              id: $selection_id
            })
            ON CREATE SET decision.selection_id = $selection_id,
                          decision.task_id = $task_id,
                          decision.personal_space_id = $personal_space_id,
                          decision.payload_fingerprint = $payload_fingerprint,
                          decision.model_strategy_key = $model_strategy_key,
                          decision.created_at = $created_at
            WITH decision,
                 coalesce(decision.payload_fingerprint, $payload_fingerprint)
                   = $payload_fingerprint AS same_payload
            WHERE same_payload
            SET decision.decision_json = $decision_json,
                decision.selected_executor_id = $selected_executor_id,
                decision.matched_rule_id = $matched_rule_id,
                decision.selection_status = $selection_status,
                decision.fallback_outcome = $fallback_outcome,
                decision.blocked_reason = $blocked_reason,
                decision.updated_at = $created_at
            WITH decision
            OPTIONAL MATCH (:FuliSpace {
              id: $personal_space_id, kind: 'personal'
            })-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask {
                    personal_space_id: $personal_space_id,
                    task_id: $task_id
                  })
            FOREACH (_ IN CASE WHEN task IS NULL THEN [] ELSE [1] END |
              SET task.selected_executor_id = $selected_executor_id,
                  task.matched_executor_rule_id = $matched_rule_id,
                  task.executor_selection_reason = $selection_reason,
                  task.executor_fallback_outcome = $fallback_outcome,
                  task.executor_fallback_reason = $fallback_reason,
                  task.executor_blocked_reason = $blocked_reason,
                  task.executor_decision_json = $decision_json,
                  task.updated_at = $created_at
            )
            RETURN decision
            ''',
            selection_id=selection.selection_id,
            personal_space_id=selection.personal_space_id,
            task_id=selection.task_id,
            payload_fingerprint=selection.payload_fingerprint,
            model_strategy_key=selection.model_strategy_key,
            created_at=selection.created_at,
            decision_json=json.dumps(raw, sort_keys=True),
            selected_executor_id=selection.selected_executor_id,
            matched_rule_id=selection.matched_rule_id,
            selection_status=selection.status,
            fallback_outcome=selection.fallback_outcome,
            blocked_reason=selection.blocked_reason,
            selection_reason=selection.selection_reason,
            fallback_reason=selection.fallback_reason,
        )
        if not records:
            raise HTTPException(
                status_code=409,
                detail='executor selection idempotency key was reused with different input',
            )

    @staticmethod
    def _policy_from_agent(raw: dict) -> ProjectAgentExecutorPolicy:
        value = raw.get('executor_policy') or raw.get('executor_policy_json')
        if value is None and raw.get('profile_json'):
            try:
                profile = json.loads(raw['profile_json'])
                value = profile.get('executor_policy')
            except (TypeError, ValueError):
                value = None
        try:
            if isinstance(value, str):
                return ProjectAgentExecutorPolicy.model_validate_json(value)
            return ProjectAgentExecutorPolicy.model_validate(value or {})
        except Exception:
            return ProjectAgentExecutorPolicy()

    @staticmethod
    def _policy_from_assignment(
        raw: dict,
    ) -> ProjectAgentExecutorPolicy | None:
        if not raw:
            return None
        value = raw.get('executor_policy') or raw.get('executor_policy_json')
        if value is None:
            return None
        try:
            if isinstance(value, str):
                return ProjectAgentExecutorPolicy.model_validate_json(value)
            return ProjectAgentExecutorPolicy.model_validate(value)
        except Exception:
            return None

    @staticmethod
    def _strategy_from_agent(raw: dict) -> ProjectAgentModelStrategy:
        value = raw.get('default_model_strategy') or raw.get('default_model_strategy_json')
        if value is None and raw.get('profile_json'):
            try:
                profile = json.loads(raw['profile_json'])
                value = profile.get('default_model_strategy')
            except (TypeError, ValueError):
                value = None
        try:
            if isinstance(value, str):
                return ProjectAgentModelStrategy.model_validate_json(value)
            return ProjectAgentModelStrategy.model_validate(value or {})
        except Exception:
            return ProjectAgentModelStrategy()

    @staticmethod
    def _candidate_ids(
        policy: ProjectAgentExecutorPolicy,
        executor_map: dict[str, ProjectAgentExecutorRecord],
        top_rules: list[ProjectAgentExecutorRoutingRuleRecord],
    ) -> tuple[list[str], str | None, ProjectAgentExecutorScope | None]:
        if policy.mode == 'locked':
            # The list is an allow-list, not a single executor.  Its explicit
            # order is retained; no candidate outside it can be considered.
            return (
                list(policy.locked_executor_ids),
                None,
                None,
            )
        candidate_ids: list[str] = []
        if policy.preferred_executor_ids:
            candidate_ids.extend(policy.preferred_executor_ids)
        for rule in top_rules:
            for executor_id in rule.executor_ids:
                if executor_id not in candidate_ids:
                    candidate_ids.append(executor_id)
        for executor_id in sorted(
            executor_map,
            key=lambda item: (executor_map[item].global_priority, item),
        ):
            if executor_id not in candidate_ids:
                candidate_ids.append(executor_id)
        return (
            candidate_ids,
            top_rules[0].rule_id if top_rules else None,
            top_rules[0].scope if top_rules else None,
        )

    @staticmethod
    def _tie_break_same_level_candidates(
        candidate_ids: list[str],
        rules: list[ProjectAgentExecutorRoutingRuleRecord],
        executor_map: dict[str, ProjectAgentExecutorRecord],
        aggregate_map: dict[str, dict],
    ) -> list[str]:
        rule_priority: dict[str, tuple[int, int]] = {}
        for rule_index, rule in enumerate(rules):
            for executor_index, executor_id in enumerate(rule.executor_ids):
                rule_priority.setdefault(executor_id, (rule.priority, executor_index))
        # Outcome evidence only resolves candidates named by same-level rules.
        # Explicit preferences and global priority remain the primary order.
        def key(executor_id: str):
            explicit = rule_priority.get(executor_id, (1_000_000, 1_000_000))
            aggregate = aggregate_map.get(executor_id) or {}
            neutral = bool(aggregate.get('neutral_due_to_insufficient_evidence', True))
            evidence_score = (
                float(aggregate.get('weighted_success', 0))
                - float(aggregate.get('weighted_failure', 0))
                if not neutral else 0.0
            )
            executor = executor_map.get(executor_id)
            return (
                explicit[0],
                explicit[1],
                -evidence_score,
                executor.global_priority if executor else 1_000_000,
                executor_id,
            )

        return sorted(candidate_ids, key=key)

    @staticmethod
    def _executor_unavailable_reason(
        executor: ProjectAgentExecutorRecord,
        required_capabilities: list[str],
        strategy: ProjectAgentModelStrategy,
    ) -> str | None:
        if executor.registration_status != 'registered':
            return f'registration status is {executor.registration_status}'
        if executor.permission_status != 'authorized' or not executor.workspace_permission:
            return 'workspace permission is not authorized'
        if executor.preflight_status != 'passed':
            return f'preflight status is {executor.preflight_status}'
        available_capabilities = {
            item.casefold() for item in executor.capabilities
        }
        missing = [
            item for item in required_capabilities
            if item.casefold() not in available_capabilities
        ]
        if missing:
            return f'missing capabilities: {", ".join(missing)}'
        if executor.health_status == 'unhealthy':
            return 'executor health is unhealthy'
        if executor.health_required and executor.health_status != 'healthy':
            return f'health status is {executor.health_status}'
        if not StoreProjectAgentExecutorRouting._select_model(
            executor.available_models,
            strategy,
        ):
            return 'no reported model satisfies the provider-neutral strategy'
        return None

    @staticmethod
    def _select_model(
        models: list[ProjectAgentExecutorModelRecord],
        strategy: ProjectAgentModelStrategy,
    ) -> ProjectAgentExecutorModelRecord | None:
        available = [item for item in models if item.available]
        if not available:
            return None
        for model in available:
            mode_ok = (
                not model.strategy_modes
                or strategy.mode in model.strategy_modes
                or strategy.mode == 'adaptive'
            )
            effort_ok = (
                not model.reasoning_efforts
                or strategy.reasoning_effort in model.reasoning_efforts
                or strategy.reasoning_effort == 'default'
            )
            capabilities = {item.casefold() for item in model.capabilities}
            hints_ok = all(
                hint.casefold() in capabilities
                for hint in strategy.capability_hints
            )
            if mode_ok and effort_ok and hints_ok:
                return model
        return None

    route_task_executor = resolve_project_agent_executor
