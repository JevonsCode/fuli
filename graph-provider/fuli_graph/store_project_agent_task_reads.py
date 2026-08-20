"""Task row reconstruction, terminal cleanup, and route-result presentation."""

from __future__ import annotations

import hashlib
import json

from .project_agent_models import ProjectAgentModelStrategy, ProjectAgentProfile
from .project_agent_task_models import (
    ProjectAgentRoutingDecisionRecord,
    ProjectAgentTaskExecutionSummary,
    ProjectAgentTaskEventRecord,
    ProjectAgentTaskParticipantRecord,
    ProjectAgentTaskRecord,
    ProjectAgentTaskRouteResult,
)
from .provider_values import native_datetime


TERMINAL_TASK_STATUSES = {'completed', 'failed', 'cancelled'}


class StoreProjectAgentTaskReads:
    """Read durable task history and derive client-facing route results."""

    async def _find_task_row(self, personal_space_id, task_id):
        records, _, _ = await self.runtime.driver.execute_query(
            self._task_read_query('WHERE task.task_id = $task_id'),
            personal_space_id=personal_space_id,
            task_id=task_id,
            routing_='r',
        )
        return records[0] if records else None

    @staticmethod
    def _task_read_query(where_clause):
        return f'''
        MATCH (space:FuliSpace {{id: $personal_space_id, kind: 'personal'}})-
              [:HAS_PROJECT_AGENT_TASK]->
              (task:FuliProjectAgentTask {{
                personal_space_id: $personal_space_id
              }})
        {where_clause}
        OPTIONAL MATCH (task)-[participant:HAS_PARTICIPANT]->
                       (participant_agent:FuliProjectAgent)
        WITH task, collect(DISTINCT {{
          agent_id: participant_agent.agent_id,
          agent_name: participant_agent.name,
          occupation_emoji: participant_agent.occupation_emoji,
          role: participant.role,
          status: participant.status,
          assignment_summary: participant.assignment_summary,
          profile_json: participant_agent.profile_json,
          joined_at: participant.joined_at,
          updated_at: participant.updated_at,
          ended_at: participant.ended_at
        }}) AS participant_rows
        OPTIONAL MATCH (task)-[:HAS_TASK_EVENT]->
                       (event:FuliProjectAgentTaskEvent)
        WITH task, participant_rows, collect(DISTINCT event) AS event_rows
        OPTIONAL MATCH (task)-[:ROUTED_BY]->
                       (decision:FuliProjectAgentRoutingDecision)
        RETURN task, participant_rows, event_rows, decision
        '''

    def _task_from_row(self, row):
        raw = dict(row['task'])
        decision_raw = dict(row['decision']) if row.get('decision') else {}
        if decision_raw.get('decision_json'):
            decision = ProjectAgentRoutingDecisionRecord.model_validate_json(
                decision_raw['decision_json']
            )
        else:
            decision = ProjectAgentRoutingDecisionRecord(
                decision_id=decision_raw.get('decision_id') or 'legacy',
                task_id=raw['task_id'],
                coordinator_agent_id=raw['coordinator_agent_id'],
                complexity=raw.get('complexity') or 'standard',
                complexity_basis=list(raw.get('complexity_basis') or []),
                selected_model_strategy=(
                    ProjectAgentModelStrategy.model_validate_json(
                        raw['effective_model_strategy_json']
                    )
                    if raw.get('effective_model_strategy_json') else None
                ),
                model_strategy_source=raw.get('model_strategy_source') or 'coordinator',
                outcome=raw.get('routing_outcome') or 'unassigned',
                reason=raw.get('routing_reason') or 'no_match',
                match_basis=list(raw.get('match_basis') or []),
                created_at=native_datetime(raw['created_at']),
            )
        events = []
        for value in row.get('event_rows') or []:
            if value is None:
                continue
            event = dict(value)
            if not event.get('event_id'):
                continue
            fields = {
                'event_id': event['event_id'],
                'task_id': event['task_id'],
                'agent_id': event.get('agent_id'),
                'status': event['status'],
                'actor_kind': event.get('actor_kind') or 'system',
                'summary': event['summary'],
                'source_application': event.get('source_application'),
                'source_session_id': event.get('source_session_id'),
                'actual_model_provider': event.get('actual_model_provider'),
                'actual_model': event.get('actual_model'),
                'created_at': native_datetime(event['created_at']),
            }
            for name in (
                'actual_executor_id',
                'matched_executor_rule_id',
                'executor_selection_reason',
                'executor_fallback_reason',
                'executor_blocked_reason',
                'worker_id',
                'worker_label',
                'worker_occupation_emoji',
                'worker_status',
            ):
                if name in ProjectAgentTaskEventRecord.model_fields:
                    fields[name] = event.get(name)
            events.append(ProjectAgentTaskEventRecord(**fields))
        events.sort(key=lambda item: item.created_at)
        fields = {
            'task_id': raw['task_id'],
            'personal_space_id': raw['personal_space_id'],
            'personal_project_id': raw['personal_project_id'],
            'title': raw['title'],
            'objective': raw['objective'],
            'work_kind': raw['work_kind'],
            'required_capabilities': list(raw.get('required_capabilities') or []),
            'duration': raw.get('duration') or 'ongoing',
            'staffing_intent': raw.get('staffing_intent') or 'reuse_preferred',
            'status': raw['status'],
            'revision': int(raw.get('revision') or 0),
            'routing_outcome': raw.get('routing_outcome') or 'unassigned',
            'routing_reason': raw.get('routing_reason') or 'no_match',
            'routing_explanation': raw.get('routing_explanation') or '',
            'match_basis': list(raw.get('match_basis') or []),
            'coordinator_agent_id': raw['coordinator_agent_id'],
            'complexity': raw.get('complexity') or 'standard',
            'complexity_basis': list(raw.get('complexity_basis') or []),
            'routing_decision': decision,
            'lead_agent_id': raw.get('lead_agent_id'),
            'participants': [
                ProjectAgentTaskParticipantRecord(
                    agent_id=value['agent_id'],
                    role=value['role'],
                    status=value['status'],
                    assignment_summary=value.get('assignment_summary'),
                    joined_at=native_datetime(value['joined_at']),
                    updated_at=native_datetime(value['updated_at']),
                    ended_at=native_datetime(value.get('ended_at')),
                )
                for value in self._participant_maps(row)
            ],
            'effective_model_strategy': (
                ProjectAgentModelStrategy.model_validate_json(
                    raw['effective_model_strategy_json']
                )
                if raw.get('effective_model_strategy_json') else None
            ),
            'model_strategy_source': raw.get('model_strategy_source') or 'coordinator',
            'hr_agent_id': raw.get('hr_agent_id'),
            'recruitment_id': raw.get('recruitment_id'),
            'source_application': raw.get('source_application'),
            'source_session_id': raw.get('source_session_id'),
            'result_summary': raw.get('result_summary'),
            'failure_reason': raw.get('failure_reason'),
            'created_at': native_datetime(raw['created_at']),
            'updated_at': native_datetime(raw['updated_at']),
            'completed_at': native_datetime(raw.get('completed_at')),
            'events': events,
        }
        fields['execution_summary'] = self._execution_summary(row, events)
        executor_raw = json.loads(raw['executor_decision_json']) \
            if raw.get('executor_decision_json') else None
        executor_policy_raw = raw.get('executor_policy_json')
        if executor_policy_raw:
            fields['executor_policy'] = json.loads(executor_policy_raw)
        for name, value in {
            'selected_executor_id': raw.get('selected_executor_id'),
            'actual_executor_id': raw.get('actual_executor_id'),
            'actual_run_id': raw.get('actual_run_id'),
            'actual_model_provider': raw.get('actual_model_provider'),
            'actual_model': raw.get('actual_model'),
            'matched_executor_rule_id': raw.get('matched_executor_rule_id'),
            'executor_selection_reason': raw.get('executor_selection_reason'),
            'executor_fallback_outcome': raw.get('executor_fallback_outcome'),
            'executor_fallback_reason': raw.get('executor_fallback_reason'),
            'executor_blocked_reason': raw.get('executor_blocked_reason'),
            'executor_decision': executor_raw,
        }.items():
            if name in ProjectAgentTaskRecord.model_fields:
                fields[name] = value
        return ProjectAgentTaskRecord(**fields)

    @staticmethod
    def _participant_maps(row):
        return [
            dict(value)
            for value in (row.get('participant_rows') or [])
            if value and value.get('agent_id') and value.get('role')
        ]

    @staticmethod
    def _participant_profile(participant):
        """Return the durable display fields, tolerating legacy profiles."""

        profile_json = participant.get('profile_json')
        profile = None
        if profile_json:
            try:
                profile = ProjectAgentProfile.model_validate_json(profile_json)
            except (TypeError, ValueError):
                # A malformed legacy profile must not make an otherwise
                # readable task invent identity data or fail the whole read.
                profile = None
        agent_name = (
            profile.name if profile else participant.get('agent_name')
        )
        occupation_emoji = (
            profile.occupation_emoji if profile else None
        ) or participant.get('occupation_emoji')
        if profile is None and profile_json:
            try:
                legacy = json.loads(profile_json)
            except (TypeError, ValueError):
                legacy = {}
            agent_name = agent_name or legacy.get('name')
            occupation_emoji = occupation_emoji or legacy.get('occupationEmoji')
            occupation_emoji = occupation_emoji or legacy.get('occupation_emoji')
        return agent_name, occupation_emoji

    @classmethod
    def _execution_summary(cls, row, events):
        """Project only observed events onto identities actually assigned."""

        result = []
        participants = cls._participant_maps(row)
        task_raw = dict(row.get('task') or {})
        task_fallback = task_raw if len(participants) == 1 else {}
        for participant in participants:
            agent_id = participant['agent_id']
            participant_events = [
                event for event in events
                if event.agent_id == agent_id
                and cls._is_execution_event(event)
            ]
            agent_name, occupation_emoji = cls._participant_profile(participant)
            worker_groups = {}
            for event in participant_events:
                if event.worker_id:
                    worker_groups.setdefault(event.worker_id, []).append(event)

            # A worker id is an explicit observation of a concrete execution
            # worker.  Preserve one row per observed worker, even when several
            # workers share one durable Agent identity.
            if worker_groups:
                for worker_id, worker_events in worker_groups.items():
                    result.append(
                        cls._execution_summary_row(
                            participant,
                            agent_name,
                            occupation_emoji,
                            worker_events,
                            worker_id=worker_id,
                            task_fallback={},
                        )
                    )
                continue

            # A configured participant is not execution evidence. Legacy
            # clients may omit worker_id, but they must still have recorded an
            # Agent-linked running/terminal event or concrete executor/model
            # evidence before a summary row exists.
            if not participant_events:
                continue
            result.append(
                cls._execution_summary_row(
                    participant,
                    agent_name,
                    occupation_emoji,
                    participant_events,
                    task_fallback=task_fallback,
                )
            )
        return result

    @staticmethod
    def _is_execution_event(event):
        return bool(
            event.worker_id
            or event.worker_status
            or event.actual_executor_id
            or event.actual_model_provider
            or event.actual_model
            or event.status in {
                'running', 'paused', 'awaiting_review', 'blocked',
                'completed', 'failed', 'cancelled',
            }
        )

    @staticmethod
    def _execution_summary_row(
        participant,
        agent_name,
        occupation_emoji,
        events,
        *,
        worker_id=None,
        task_fallback=None,
    ):
        task_fallback = task_fallback or {}
        latest = events[-1] if events else None

        def latest_value(name):
            return next(
                (
                    getattr(event, name)
                    for event in reversed(events)
                    if getattr(event, name, None) is not None
                ),
                None,
            )

        actual_executor_id = (
            latest_value('actual_executor_id')
            or task_fallback.get('actual_executor_id')
        )
        worker_label = latest_value('worker_label')
        worker_occupation_emoji = latest_value('worker_occupation_emoji')
        worker_status = latest_value('worker_status')
        status = worker_status or (
            latest.status
            if latest
            else participant['status']
        )
        return ProjectAgentTaskExecutionSummary(
            agent_id=participant['agent_id'],
            agent_name=agent_name,
            occupation_emoji=occupation_emoji,
            participant_role=participant['role'],
            executor=actual_executor_id,
            executor_id=actual_executor_id,
            source_application=latest_value('source_application'),
            actual_model_provider=(
                latest_value('actual_model_provider')
                or task_fallback.get('actual_model_provider')
            ),
            actual_model=(
                latest_value('actual_model')
                or task_fallback.get('actual_model')
            ),
            work_summary=(
                latest.summary
                if latest
                else task_fallback.get('result_summary')
                or task_fallback.get('failure_reason')
            ),
            status=status,
            worker_id=worker_id,
            worker_label=worker_label,
            worker_occupation_emoji=worker_occupation_emoji,
        )

    async def _archive_finished_temporary_agent(self, request, raw_task, updated_at):
        if request.status not in TERMINAL_TASK_STATUSES:
            return
        await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {
              id: $personal_space_id, kind: 'personal'
            })-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask {task_id: $task_id})-
                  [:HAS_PARTICIPANT]->
                  (agent:FuliProjectAgent {
                    agent_type: 'temporary',
                    temporary_task_id: $task_id
                  })
            SET agent.status = 'archived',
                agent.updated_at = $updated_at
            WITH space, agent
            MATCH (space)-[:CONTAINS_PROJECT]->(:FuliPersonalProject)-
                  [:HAS_PROJECT_AGENT_ASSIGNMENT]->
                  (assignment:FuliProjectAgentAssignment {status: 'active'})-
                  [:ASSIGNED_AGENT]->(agent)
            SET assignment.status = 'ended',
                assignment.end_reason = 'temporary task reached terminal state',
                assignment.ended_at = $updated_at,
                assignment.updated_at = $updated_at,
                assignment.revision = assignment.revision + 1
            ''',
            personal_space_id=request.personal_space_id,
            task_id=request.task_id,
            updated_at=updated_at,
        )

    @staticmethod
    def _routing_explanation(reason, match_basis, executor_decision):
        basis = '; '.join(match_basis) if match_basis else 'no exact assignment match'
        value = f'{reason}: {basis}'
        if executor_decision:
            raw = (
                executor_decision.model_dump(mode='json')
                if hasattr(executor_decision, 'model_dump')
                else executor_decision
            )
            executor_reason = raw.get('selection_reason') or raw.get('reason')
            if executor_reason:
                value += f'; executor: {executor_reason}'
        return value

    @staticmethod
    def _payload_hash(request):
        payload = request.model_dump(mode='json', exclude={'idempotency_key'})
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()
        ).hexdigest()

    def _route_result(self, task, recruitment, *, assigned_agent=None):
        if recruitment and recruitment.status == 'fulfilled':
            decision = 'recruited'
        elif recruitment and recruitment.status == 'awaiting_confirmation':
            decision = 'awaiting_confirmation'
        elif task.routing_outcome == 'assigned_existing':
            decision = 'reused'
        elif task.routing_outcome == 'unassigned':
            decision = 'unassigned'
        else:
            decision = 'blocked'
        notice = None
        must_disclose = bool(
            recruitment
            and recruitment.confirmation_mode == 'automatic'
            and recruitment.status == 'fulfilled'
        )
        if must_disclose:
            notice = (
                f'HR {recruitment.hr_agent_id} recruited '
                f'{recruitment.proposed_profile.name} as a '
                f'{recruitment.position_kind} Agent for '
                f'{recruitment.proposed_profile.responsibility}. '
                f'Reason: {recruitment.reason}. '
                f'Trigger: {recruitment.trigger_source_application or "unspecified"}; '
                f'time: {recruitment.fulfilled_at.isoformat() if recruitment.fulfilled_at else "pending"}.'
            )
        return ProjectAgentTaskRouteResult(
            task=task,
            assigned_agent=assigned_agent,
            recruitment=recruitment,
            decision=decision,
            must_disclose_recruitment=must_disclose,
            client_notice=notice,
        )
