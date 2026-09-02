"""Agent assignment selection, history continuity, and parallel staffing."""

from datetime import datetime

from fastapi import HTTPException

from .project_agent_access import authorize_project_agent
from .project_agent_models import ProjectAgentProfile
from .project_agent_task_models import ProjectAgentParallelPlan


class StoreProjectAgentTaskStaffing:
    """Keep task routing's staffing mechanics separate from task persistence."""

    async def _select_agents(self, actor, space, request):
        if request.staffing_intent == 'unassigned':
            return [], [], 'explicit_unassigned', ['user explicitly left task unassigned']
        assignment_rows = await self._assignment_candidates(
            request.personal_space_id,
            request.personal_project_id,
        )
        if request.lead_agent_id:
            await authorize_project_agent(
                self,
                actor,
                space,
                request.personal_project_id,
                request.lead_agent_id,
                require_active=True,
            )
            matched = [
                row for row in assignment_rows
                if row['agent_id'] == request.lead_agent_id
            ]
            if not matched:
                raise HTTPException(status_code=409, detail='lead Agent assignment is inactive')
            self._require_agent_client_allowed(
                matched[0],
                request.source_application,
            )
            return matched[:1], matched, 'explicit_agent', ['explicit Agent selected']
        rows = [
            row for row in assignment_rows
            if self._agent_client_allowed(row, request.source_application)
        ]
        if request.staffing_intent in {'new_durable', 'temporary'}:
            return (
                [],
                rows,
                'explicit_temporary_agent'
                if request.staffing_intent == 'temporary'
                else 'explicit_new_agent',
                ['user explicitly requested recruitment'],
            )
        policy = await self.get_project_agent_coordination_policy(
            actor,
            request.personal_space_id,
            request.personal_project_id,
        )
        if not policy.auto_reuse_previous_agent:
            return [], rows, 'manual_agent_selection', [
                'project policy requires an explicit @Agent selection',
            ]
        normalized_work_kind = request.work_kind.casefold()
        required = {item.casefold() for item in request.required_capabilities}
        eligible = [row for row in rows if required.issubset({
            item.casefold() for item in row.get('capabilities', [])
        })]
        candidates, history = await self._rank_agent_candidates(eligible, request)
        # Continuity may break a tie between qualified specialists; it must
        # never override a capability requirement or a stronger work-kind fit.
        continuity_pool = eligible
        if candidates:
            best_work_match = normalized_work_kind in {
                item.casefold() for item in candidates[0].get('work_kinds', [])
            }
            continuity_pool = [row for row in candidates if (
                normalized_work_kind in {item.casefold() for item in row.get('work_kinds', [])}
            ) == best_work_match]
        if continuity_pool:
            least_busy = min(self._metric_int(row.get('active_task_count')) for row in continuity_pool)
            continuity_pool = [row for row in continuity_pool
                if self._metric_int(row.get('active_task_count')) == least_busy]
        continuity, project_history = await self._rank_project_continuity(
            continuity_pool,
            request,
        )
        if continuity:
            selected = continuity[0]
            remaining = [row for row in candidates or eligible if row['agent_id'] != selected['agent_id']]
            return [selected], [selected, *remaining], 'project_continuity', [
                self._project_history_match_basis(
                    project_history.get(selected['agent_id']),
                ),
                *self._automatic_selection_basis(selected, request),
            ]
        if not candidates:
            unavailable_match = any(
                not self._agent_client_allowed(row, request.source_application)
                and (
                    normalized_work_kind in {
                        item.casefold() for item in row.get('work_kinds', [])
                    }
                    or (
                        required
                        and required.issubset({
                            item.casefold()
                            for item in row.get('capabilities', [])
                        })
                    )
                )
                for row in assignment_rows
            )
            if unavailable_match:
                return [], rows, 'agent_unavailable', [
                    'matching Agent is unavailable to source client: '
                    f'{request.source_application or "other"}',
                ]
            if len(eligible) == 1:
                return [eligible[0]], eligible, 'sole_active_assignment', [
                    'the project has one active Agent assignment',
                    *self._automatic_selection_basis(eligible[0], request),
                ]
            if eligible and normalized_work_kind == 'project_context' and not required:
                eligible.sort(key=lambda row: (
                    self._metric_int(row.get('active_task_count')),
                    -int(self._metric_int(row.get('memory_revision')) > 0),
                    row['assigned_at'], row['agent_id'],
                ))
                return eligible[:1], eligible, 'project_default', [
                    f'{len(eligible)} eligible project roles; working-memory continuity and stable tie-break',
                    *self._automatic_selection_basis(eligible[0], request),
                ]
            return [], rows, 'no_match', ['no active assignment matched exactly']
        selected = candidates[0]
        if normalized_work_kind in {
            item.casefold() for item in selected.get('work_kinds', [])
        }:
            match_basis = [
                f'exact work kind: {request.work_kind}',
            ]
            reason = 'exact_work_kind'
        else:
            match_basis = ['all required capabilities matched exactly']
            reason = 'exact_capability'
        history_basis = self._history_match_basis(
            history.get(selected['agent_id']),
            request.work_kind,
        )
        if history_basis:
            match_basis.append(history_basis)
        match_basis.extend(item for item in self._automatic_selection_basis(selected, request)
                           if item not in match_basis)
        return [selected], candidates, reason, match_basis

    def _automatic_selection_basis(self, selected, request):
        work_kind = request.work_kind.casefold()
        if work_kind == 'project_context':
            work_basis = 'general project context: continuity only, not semantic task matching'
        elif work_kind in {item.casefold() for item in selected.get('work_kinds', [])}:
            work_basis = f'exact work kind: {request.work_kind}'
        else:
            match = ('explicit capabilities matched' if request.required_capabilities
                     else 'continuity only, not semantic task matching')
            work_basis = f'no exact work-kind match: {request.work_kind}; {match}'
        return [work_basis,
                f'selected active task count: {self._metric_int(selected.get("active_task_count"))}; '
                'work-kind fit and load precede history']

    async def _rank_agent_candidates(self, rows, request):
        """Rank already source-eligible assignments with task-history continuity."""

        normalized_work_kind = request.work_kind.casefold()
        required = {item.casefold() for item in request.required_capabilities}
        scored = []
        for row in rows:
            work_kinds = {item.casefold() for item in row.get('work_kinds', [])}
            capabilities = {item.casefold() for item in row.get('capabilities', [])}
            work_match = normalized_work_kind in work_kinds
            capability_match = required.issubset(capabilities)
            if not capability_match:
                continue
            if not work_match and not (required and capability_match):
                continue
            score = (2 if work_match else 0) + (1 if capability_match else 0)
            scored.append((score, row))
        if not scored:
            return [], {}
        history = await self._historical_agent_outcomes(
            request.personal_space_id,
            request.personal_project_id,
            request.work_kind,
            [row['agent_id'] for _, row in scored],
        )
        scored.sort(
            key=lambda item: (
                -item[0],
                self._metric_int(item[1].get('active_task_count')),
                *self._history_sort_key(history.get(item[1]['agent_id'])),
                -int(self._metric_int(item[1].get('memory_revision')) > 0),
                item[1]['assigned_at'],
                item[1]['agent_id'],
            )
        )
        return [item[1] for item in scored], history

    async def _rank_project_continuity(self, rows, request):
        """Prefer an effective previous lead among equally qualified available roles."""

        if not rows:
            return [], {}
        history = await self._historical_project_agent_outcomes(
            request.personal_space_id,
            request.personal_project_id,
            [row['agent_id'] for row in rows],
        )
        candidates = [
            row
            for row in rows
            if sum(
                self._metric_int(
                    (history.get(row['agent_id']) or {}).get(metric)
                )
                for metric in (
                    'completed_count',
                    'failed_count',
                    'cancelled_count',
                )
            ) > 0
        ]
        candidates.sort(
            key=lambda row: (
                *self._project_history_sort_key(history.get(row['agent_id'])),
                row['assigned_at'],
                row['agent_id'],
            )
        )
        return candidates, history

    async def _historical_project_agent_outcomes(
        self,
        personal_space_id,
        personal_project_id,
        agent_ids,
    ):
        """Read cross-work-kind lead history for sticky project continuity."""

        if not agent_ids:
            return {}
        runtime = getattr(self, 'runtime', None)
        driver = getattr(runtime, 'driver', None)
        if driver is None:
            return {}
        records, _, _ = await driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask {
                    personal_space_id: $personal_space_id,
                    personal_project_id: $personal_project_id
                  })-[participant:HAS_PARTICIPANT]->
                  (agent:FuliProjectAgent)
            WHERE agent.agent_id IN $agent_ids
              AND (participant.role = 'lead'
                   OR task.lead_agent_id = agent.agent_id)
            OPTIONAL MATCH (task)-[:HAS_TASK_EVENT]->
                  (event:FuliProjectAgentTaskEvent)-[:EVENT_AGENT]->(agent)
            RETURN agent.agent_id AS agent_id,
                   count(DISTINCT CASE
                     WHEN participant.status IN
                       ['completed', 'failed', 'cancelled']
                       OR event.status IN
                       ['completed', 'failed', 'cancelled']
                     THEN task.task_id END
                   ) AS participation_count,
                   count(DISTINCT CASE
                     WHEN participant.status = 'completed'
                       OR event.status = 'completed'
                     THEN task.task_id END
                   ) AS completed_count,
                   count(DISTINCT CASE
                     WHEN participant.status = 'failed'
                       OR event.status = 'failed'
                     THEN task.task_id END
                   ) AS failed_count,
                   count(DISTINCT CASE
                     WHEN participant.status = 'cancelled'
                       OR event.status = 'cancelled'
                     THEN task.task_id END
                   ) AS cancelled_count,
                   max(CASE
                     WHEN participant.status IN
                       ['completed', 'failed', 'cancelled']
                       OR event.status IN
                       ['completed', 'failed', 'cancelled']
                     THEN coalesce(event.created_at, task.updated_at) END
                   ) AS last_task_at,
                   max(CASE
                     WHEN participant.status = 'completed'
                       OR event.status = 'completed'
                     THEN coalesce(event.created_at, task.updated_at) END
                   ) AS last_completed_at
            ''',
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            agent_ids=list(agent_ids),
            routing_='r',
        )
        result = {}
        for row in records or []:
            raw = dict(row)
            agent_id = raw.get('agent_id')
            if not agent_id:
                continue
            result[agent_id] = {
                'participation_count': self._metric_int(
                    raw.get('participation_count')
                ),
                'completed_count': self._metric_int(raw.get('completed_count')),
                'failed_count': self._metric_int(raw.get('failed_count')),
                'cancelled_count': self._metric_int(raw.get('cancelled_count')),
                'last_task_at': raw.get('last_task_at'),
                'last_completed_at': raw.get('last_completed_at'),
            }
        return result

    async def _historical_agent_outcomes(
        self,
        personal_space_id,
        personal_project_id,
        work_kind,
        agent_ids,
    ):
        """Read project/work-kind participation without making history mandatory."""

        if not agent_ids:
            return {}
        runtime = getattr(self, 'runtime', None)
        driver = getattr(runtime, 'driver', None)
        if driver is None:
            return {}
        records, _, _ = await driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask {
                    personal_space_id: $personal_space_id,
                    personal_project_id: $personal_project_id
                  })-[participant:HAS_PARTICIPANT]->
                  (agent:FuliProjectAgent)
            WHERE agent.agent_id IN $agent_ids
              AND toLower(task.work_kind) = toLower($work_kind)
            OPTIONAL MATCH (task)-[:HAS_TASK_EVENT]->
                  (event:FuliProjectAgentTaskEvent)-[:EVENT_AGENT]->(agent)
            RETURN agent.agent_id AS agent_id,
                   count(DISTINCT CASE
                     WHEN participant.status IN
                       ['completed', 'failed', 'cancelled']
                       OR event.status IN
                       ['completed', 'failed', 'cancelled']
                     THEN task.task_id END
                   ) AS participation_count,
                   count(DISTINCT CASE
                     WHEN participant.status = 'completed'
                       OR event.status = 'completed'
                     THEN task.task_id END
                   ) AS completed_count,
                   count(DISTINCT CASE
                     WHEN participant.status = 'failed'
                       OR event.status = 'failed'
                     THEN task.task_id END
                   ) AS failed_count,
                   count(DISTINCT CASE
                     WHEN participant.status = 'cancelled'
                       OR event.status = 'cancelled'
                     THEN task.task_id END
                   ) AS cancelled_count,
                   max(CASE
                     WHEN participant.status IN
                       ['completed', 'failed', 'cancelled']
                       OR event.status IN
                       ['completed', 'failed', 'cancelled']
                     THEN coalesce(event.created_at, task.updated_at) END
                   ) AS last_outcome_at
            ''',
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            work_kind=work_kind,
            agent_ids=list(agent_ids),
            routing_='r',
        )
        result = {}
        for row in records or []:
            raw = dict(row)
            agent_id = raw.get('agent_id')
            if not agent_id:
                continue
            result[agent_id] = {
                'participation_count': self._metric_int(
                    raw.get('participation_count')
                ),
                'completed_count': self._metric_int(raw.get('completed_count')),
                'failed_count': self._metric_int(raw.get('failed_count')),
                'cancelled_count': self._metric_int(
                    raw.get('cancelled_count')
                ),
                'last_outcome_at': raw.get('last_outcome_at'),
            }
        return result

    @staticmethod
    def _metric_int(value):
        try:
            return max(0, int(value or 0))
        except (TypeError, ValueError):
            return 0

    @classmethod
    def _history_sort_key(cls, history):
        history = history or {}
        completed = cls._metric_int(history.get('completed_count'))
        failed = cls._metric_int(history.get('failed_count'))
        cancelled = cls._metric_int(history.get('cancelled_count'))
        participation = cls._metric_int(history.get('participation_count'))
        # A successful prior task is the strongest continuity signal. Failed
        # and cancelled outcomes lower the signal, while participation remains
        # a deterministic tie-breaker for otherwise equivalent outcomes.
        outcome_score = completed * 3 - failed * 2 - cancelled
        return (
            -outcome_score,
            -completed,
            failed,
            cancelled,
            -participation,
        )

    @classmethod
    def _project_history_sort_key(cls, history):
        history = history or {}
        completed = cls._metric_int(history.get('completed_count'))
        failed = cls._metric_int(history.get('failed_count'))
        cancelled = cls._metric_int(history.get('cancelled_count'))
        participation = cls._metric_int(history.get('participation_count'))
        effective_time = (
            history.get('last_completed_at')
            if completed > 0
            else history.get('last_task_at')
        )
        outcome_score = completed * 3 - failed * 2 - cancelled
        return (
            0 if completed > 0 else 1,
            -cls._history_timestamp(effective_time),
            -outcome_score,
            -participation,
        )

    @staticmethod
    def _history_timestamp(value):
        if value is None:
            return 0.0
        if hasattr(value, 'to_native'):
            value = value.to_native()
        if hasattr(value, 'timestamp'):
            try:
                return float(value.timestamp())
            except (TypeError, ValueError, OSError):
                return 0.0
        try:
            return datetime.fromisoformat(
                str(value).replace('Z', '+00:00')
            ).timestamp()
        except (TypeError, ValueError, OSError):
            return 0.0

    @classmethod
    def _project_history_match_basis(cls, history):
        history = history or {}
        participation = cls._metric_int(history.get('participation_count'))
        completed = cls._metric_int(history.get('completed_count'))
        if completed:
            return (
                'last successful project lead continuity: '
                f'{participation} prior task(s), {completed} completed'
            )
        return f'most recent project lead continuity: {participation} prior task(s)'

    @classmethod
    def _history_match_basis(cls, history, work_kind):
        if not history:
            return None
        participation = cls._metric_int(history.get('participation_count'))
        if participation <= 0:
            return None
        completed = cls._metric_int(history.get('completed_count'))
        failed = cls._metric_int(history.get('failed_count'))
        cancelled = cls._metric_int(history.get('cancelled_count'))
        return (
            f'historical continuity for {work_kind}: '
            f'{participation} prior task(s), '
            f'{completed} completed, {failed} failed, {cancelled} cancelled'
        )

    async def _parallel_staffing_candidates(
        self,
        request,
        candidates,
        participants,
    ):
        capacity = len(request.parallel_plan.workstream_boundaries) - len(participants)
        if capacity <= 0:
            return []
        pool = list(candidates)
        known_ids = {item['agent_id'] for item in pool}
        for row in await self._assignment_candidates(
            request.personal_space_id,
            request.personal_project_id,
        ):
            if row['agent_id'] not in known_ids:
                pool.append(row)
                known_ids.add(row['agent_id'])
        eligible = [
            row
            for row in pool
            if self._agent_client_allowed(row, request.source_application)
        ]
        ranked, _ = await self._rank_agent_candidates(eligible, request)
        participant_ids = {item['agent_id'] for item in participants}
        return [
            row
            for row in ranked
            if row['agent_id'] not in participant_ids
        ][:capacity]

    @staticmethod
    def _add_parallel_collaborators(plan, participants, candidates):
        if not plan.enabled:
            return []
        limit = len(plan.workstream_boundaries)
        participant_ids = {item['agent_id'] for item in participants}
        added = []
        for candidate in candidates:
            if len(participants) >= limit:
                break
            agent_id = candidate['agent_id']
            if agent_id in participant_ids:
                continue
            participant = {
                'agent_id': agent_id,
                'role': 'collaborator',
                'assignment_summary': candidate.get('responsibility'),
            }
            participants.append(participant)
            participant_ids.add(agent_id)
            added.append(candidate)
        return added

    async def _parallel_plan_participant_projection(
        self,
        actor,
        request,
        *,
        lead,
        participants,
        routing_reason,
        recruitment_slots=None,
    ):
        """Project every Agent automatic recruitment will add before writes.

        Parallel-plan validation runs before recruitment because recruitment is
        itself durable (and automatic recruitment provisions an Agent and an
        assignment). Confirmation-mode recruitment does not create an Agent yet
        and must therefore not count as an active participant.
        """

        projected = list(participants)
        slots = recruitment_slots
        if slots is None:
            slots = await self._automatic_parallel_recruitment_slots(
                actor,
                request,
                lead=lead,
                participants=participants,
                routing_reason=routing_reason,
            )
        for slot in slots:
            participant = {
                'agent_id': slot['placeholder_agent_id'],
                'role': slot['participant_role'],
            }
            if slot['participant_role'] == 'lead':
                projected.insert(0, participant)
            else:
                projected.append(participant)
        return projected

    async def _automatic_parallel_recruitment_slots(
        self,
        actor,
        request,
        *,
        lead,
        participants,
        routing_reason,
    ):
        plan = request.parallel_plan
        if not plan.enabled:
            return []
        if (
            request.staffing_intent == 'unassigned'
            or routing_reason == 'manual_agent_selection'
        ):
            return []

        roles = []
        projected_count = len(participants)
        if not lead:
            roles.append('lead')
            projected_count += 1
        while projected_count < 2:
            roles.append('collaborator')
            projected_count += 1
        if not roles:
            return []

        policy = await self.get_project_agent_coordination_policy(
            actor,
            request.personal_space_id,
            request.personal_project_id,
        )
        if policy.ask_before_recruitment:
            return []
        hr_records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:HAS_PROJECT_AGENT_IDENTITY]->
                  (hr:FuliProjectAgent {agent_type: 'hr', status: 'active'})
            RETURN hr LIMIT 1
            ''',
            personal_space_id=request.personal_space_id,
            routing_='r',
        )
        if not hr_records:
            return []

        collaborator_index = 0
        slots = []
        for role in roles:
            if role == 'lead':
                slot = 'lead'
            else:
                collaborator_index += 1
                slot = f'collaborator-{collaborator_index}'
            slots.append({
                'participant_role': role,
                'recruitment_slot': slot,
                'placeholder_agent_id': (
                    f"__recruited_{slot.replace('-', '_')}__"
                ),
            })
        return slots

    async def _assignment_candidates(
        self,
        personal_space_id,
        personal_project_id,
        *,
        include_temporary=False,
    ):
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:CONTAINS_PROJECT]->
                  (:FuliPersonalProject {project_id: $personal_project_id})-
                  [:HAS_PROJECT_AGENT_ASSIGNMENT]->
                  (assignment:FuliProjectAgentAssignment {status: 'active'})-
                  [:ASSIGNED_AGENT]->(agent:FuliProjectAgent {status: 'active'})
            WHERE agent.agent_type = 'durable'
               OR ($include_temporary = true AND agent.agent_type = 'temporary')
            OPTIONAL MATCH (agent)-[:HAS_WORKING_MEMORY]->(memory:FuliProjectAgentMemory {
              personal_space_id: $personal_space_id, personal_project_id: $personal_project_id
            })
            WITH space, assignment, agent, coalesce(max(memory.revision), 0) AS memory_revision
            OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->(active_task:FuliProjectAgentTask)
                  -[participant:HAS_PARTICIPANT]->(agent)
            WHERE active_task.personal_project_id = $personal_project_id
              AND active_task.status IN ['queued', 'running', 'awaiting_review']
              AND participant.status IN ['queued', 'running', 'awaiting_review']
            WITH space, assignment, agent, memory_revision,
                 count(DISTINCT active_task) AS task_count
            OPTIONAL MATCH (session:FuliTaskContextSession)-[:HAS_CONTEXT]->
                  (context:FuliTaskContext {personal_space_id: $personal_space_id,
                    personal_project_id: $personal_project_id,
                    project_agent_id: agent.agent_id, completed: false})
            WHERE session.current_token = context.token
              AND context.created_at > datetime() - duration('PT2H')
            WITH assignment, agent, memory_revision, task_count,
                 count(DISTINCT context) AS context_count
            RETURN assignment, agent, memory_revision,
                   task_count + context_count AS active_task_count
            ORDER BY assignment.assigned_at, agent.agent_id
            ''',
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            include_temporary=include_temporary,
            routing_='r',
        )
        result = []
        for row in records:
            assignment = dict(row['assignment'])
            agent = dict(row['agent'])
            profile = ProjectAgentProfile.model_validate_json(agent['profile_json'])
            result.append({
                'agent_id': agent['agent_id'],
                'assignment_id': assignment.get('assignment_id') or assignment['id'],
                'responsibility': assignment.get('responsibility'),
                'work_kinds': list(
                    assignment.get('work_kinds') or profile.work_kinds
                ),
                'capabilities': list(
                    assignment.get('capabilities') or profile.capabilities
                ),
                'model_strategy_override': assignment.get('model_strategy_json'),
                'executor_policy_override': assignment.get(
                    'executor_policy_json'
                ),
                'profile': profile,
                'assigned_at': str(assignment.get('assigned_at') or ''),
                'active_task_count': row.get('active_task_count') or 0,
                'memory_revision': row.get('memory_revision') or 0,
            })
        return result

    async def _explicit_collaborators(self, actor, space, request):
        if not request.collaborator_agent_ids:
            return []
        rows = await self._assignment_candidates(
            request.personal_space_id,
            request.personal_project_id,
        )
        result = []
        for agent_id in request.collaborator_agent_ids:
            await authorize_project_agent(
                self,
                actor,
                space,
                request.personal_project_id,
                agent_id,
                require_active=True,
            )
            row = next((item for item in rows if item['agent_id'] == agent_id), None)
            if not row:
                raise HTTPException(
                    status_code=409,
                    detail=f'collaborator Agent assignment is inactive: {agent_id}',
                )
            self._require_agent_client_allowed(
                row,
                request.source_application,
            )
            result.append(row)
        return result

    @staticmethod
    def _agent_client_allowed(candidate, source_application):
        profile = candidate.get('profile') if isinstance(candidate, dict) else candidate
        allowed_clients = set(profile.allowed_clients)
        return (source_application or 'other') in allowed_clients

    @classmethod
    def _require_agent_client_allowed(cls, candidate, source_application):
        if cls._agent_client_allowed(candidate, source_application):
            return
        agent_id = candidate.get('agent_id') if isinstance(candidate, dict) else None
        raise HTTPException(
            status_code=403,
            detail=(
                f'project Agent is not available to this source client: '
                f'{agent_id or "selected Agent"}'
            ),
        )

    @staticmethod
    def _verify_parallel_plan(plan: ProjectAgentParallelPlan, participants: list[dict]):
        if plan.enabled and len(participants) > len(plan.workstream_boundaries):
            raise HTTPException(
                status_code=422,
                detail='parallel work exceeds declared workstream boundaries',
            )
        if plan.enabled and len(participants) < 2:
            raise HTTPException(
                status_code=422,
                detail=(
                    'parallel work requires at least two active Agents; '
                    'automatic recruitment needs an active HR Agent, otherwise '
                    'recruit another qualified collaborator or assign enough '
                    'existing Agents before enabling parallel work'
                ),
            )
