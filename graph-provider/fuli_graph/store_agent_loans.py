import json
from fastapi import HTTPException
from .personal_project_access import authorize_personal_project
from .project_agent_access import authorize_project_agent
from .project_agent_models import ProjectAgentAssignmentCreate, ProjectAgentAssignmentEnd
from .provider_values import now_utc, stable_uuid
from .store_transactions import query_store_transaction


class StoreAgentLoans:
    async def _loan_lead(self, actor, request):
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        task = await self.get_task_context(actor, request.personal_space_id,
            request.task_context_token, request.source_application)
        policy = await self.get_project_agent_coordination_policy(actor,
            request.personal_space_id, task['personal_project_id'])
        if not policy.team_lead_agent_id or task['project_agent_id'] != policy.team_lead_agent_id:
            raise HTTPException(403, 'Ask the current project team lead to coordinate this loan')
        lead = await authorize_project_agent(self, actor, space, task['personal_project_id'],
            task['project_agent_id'], require_active=True)
        if request.source_application not in json.loads(lead['profile_json']).get('allowed_clients', []):
            raise HTTPException(403, 'Team lead is not allowed in this client')
        return task

    async def list_agent_loans(self, actor, request):
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'reader')
        await authorize_personal_project(self, actor, space, request.personal_project_id)
        rows, _, _ = await self.runtime.driver.execute_query(
            'MATCH (l:FuliAgentLoan {space: $space}) WHERE l.source_project=$project OR l.target_project=$project '
            'RETURN l.record_json AS record_json ORDER BY l.updated_at DESC LIMIT 30',
            space=request.personal_space_id, project=request.personal_project_id)
        return {'loans': [json.loads(row['record_json']) for row in rows]}

    async def request_agent_loan(self, actor, request):
        async with query_store_transaction(self) as store:
            task = await store._loan_lead(actor, request)
            if task['personal_project_id'] == request.source_project_id:
                raise HTTPException(422, 'Use an existing project assignment for a local specialist')
            space = await store.authorize(actor, request.personal_space_id, 'maintainer')
            specialist = await authorize_project_agent(store, actor, space, request.source_project_id,
                request.specialist_id, require_active=True, require_memory=True)
            source_policy = await store.get_project_agent_coordination_policy(actor,
                request.personal_space_id, request.source_project_id)
            if not source_policy.team_lead_agent_id:
                raise HTTPException(409, 'The source project needs a team lead before a loan')
            if request.specialist_id == source_policy.team_lead_agent_id:
                raise HTTPException(409, 'Keep project team leads available; request a specialist member')
            profile = json.loads(specialist['profile_json'])
            if request.source_application not in profile.get('allowed_clients', []):
                raise HTTPException(403, 'Specialist is not allowed in the destination client')
            rows, _, _ = await store.runtime.driver.execute_query(
                'MATCH (t:FuliProjectAgentTask {task_id:$task, personal_space_id:$space, personal_project_id:$project}) '
                'SET t.loan_serial=coalesce(t.loan_serial,0)+1 WITH t '
                "WHERE NOT t.status IN ['completed','cancelled','failed'] RETURN t.work_kind AS work_kind",
                task=request.target_task_id, space=request.personal_space_id, project=task['personal_project_id'])
            if not rows:
                raise HTTPException(404, 'Active destination task not found')
            loan_id = stable_uuid('agent-loan', request.personal_space_id, request.idempotency_key)
            record = dict(loan_id=loan_id, personal_space_id=request.personal_space_id,
                source_project_id=request.source_project_id, target_project_id=task['personal_project_id'],
                source_lead_id=source_policy.team_lead_agent_id, target_lead_id=task['project_agent_id'],
                specialist_id=request.specialist_id, target_task_id=request.target_task_id,
                objective=request.objective, work_kind=rows[0]['work_kind'], status='requested',
                source_application=request.source_application, assignment_id=None)
            fingerprint = store._payload_hash(request)
            result, _, _ = await store.runtime.driver.execute_query(
                'MERGE (l:FuliAgentLoan {id:$id}) ON CREATE SET l.space=$space, l.source_project=$source, '
                'l.target_project=$target, l.task_id=$task, l.fingerprint=$fingerprint, '
                'l.record_json=$record, l.updated_at=$now RETURN l.record_json AS record_json, l.fingerprint AS fingerprint',
                id=loan_id, space=request.personal_space_id, source=request.source_project_id,
                target=task['personal_project_id'], task=request.target_task_id, fingerprint=fingerprint,
                record=json.dumps(record), now=now_utc().isoformat())
            if result[0]['fingerprint'] != fingerprint:
                raise HTTPException(409, 'Loan idempotency key has different input')
            return json.loads(result[0]['record_json'])

    async def decide_agent_loan(self, actor, request):
        async with query_store_transaction(self) as store:
            task = await store._loan_lead(actor, request)
            rows, _, _ = await store.runtime.driver.execute_query(
                'MATCH (l:FuliAgentLoan {id:$id, space:$space}) '
                'MATCH (t:FuliProjectAgentTask {task_id:l.task_id, personal_space_id:$space}) '
                'SET t.loan_serial=coalesce(t.loan_serial,0)+1 WITH l,t '
                'SET l.serial=coalesce(l.serial,0)+1 RETURN l.record_json AS record_json, t.status AS task_status', id=request.loan_id, space=request.personal_space_id)
            if not rows:
                raise HTTPException(404, 'Loan not found')
            record = json.loads(rows[0]['record_json'])
            source_lead = task['personal_project_id'] == record['source_project_id'] and task['project_agent_id'] == record['source_lead_id']
            target_lead = task['personal_project_id'] == record['target_project_id'] and task['project_agent_id'] == record['target_lead_id']
            if not source_lead and not (request.decision == 'close' and target_lead):
                raise HTTPException(403, 'The source team lead must decide this loan')
            if request.decision == 'close':
                return await store._close_agent_loan(actor, record)
            if request.decision == 'approve' and rows[0]['task_status'] in ('completed', 'cancelled', 'failed'):
                raise HTTPException(409, 'Destination task has ended')
            expected = 'approved' if request.decision == 'approve' else 'rejected'
            if record['status'] == expected:
                return record
            if record['status'] != 'requested':
                raise HTTPException(409, 'Loan already decided')
            if request.decision == 'approve':
                space = await store.authorize(actor, request.personal_space_id, 'maintainer')
                specialist = await authorize_project_agent(store, actor, space, record['source_project_id'],
                    record['specialist_id'], require_active=True, require_memory=True)
                if record['source_application'] not in json.loads(specialist['profile_json']).get('allowed_clients', []):
                    raise HTTPException(403, 'Specialist is no longer allowed in the destination client')
                assignment = await store.create_project_agent_assignment(actor, ProjectAgentAssignmentCreate(
                    personal_space_id=record['personal_space_id'], personal_project_id=record['target_project_id'],
                    agent_id=record['specialist_id'], idempotency_key=f"loan:{record['loan_id']}",
                    responsibility=record['objective'], work_kinds=[record['work_kind']],
                    reason='Task-scoped specialist loan approved by both project leads',
                    source_application=record['source_application']))
                record['assignment_id'] = assignment.assignment_id
            record['status'] = expected
            await store._save_agent_loan(record)
            return record

    async def _save_agent_loan(self, record):
        await self.runtime.driver.execute_query('MATCH (l:FuliAgentLoan {id:$id}) SET l.record_json=$record, l.updated_at=$now',
            id=record['loan_id'], record=json.dumps(record), now=now_utc().isoformat())

    async def _close_agent_loan(self, actor, record):
        if record['status'] == 'closed':
            return record
        if record.get('assignment_id') and record['status'] == 'approved':
            assignments, _, _ = await self.runtime.driver.execute_query(
                'MATCH (a:FuliProjectAgentAssignment {assignment_id:$id}) RETURN a.status AS status, a.revision AS revision',
                id=record['assignment_id'])
            if assignments and assignments[0]['status'] == 'active':
                await self.end_project_agent_assignment(actor, ProjectAgentAssignmentEnd(
                    personal_space_id=record['personal_space_id'], personal_project_id=record['target_project_id'],
                    assignment_id=record['assignment_id'], expected_revision=assignments[0]['revision'], reason='Specialist loan finished'))
        record['status'] = 'closed'
        await self._save_agent_loan(record)
        return record

    async def close_task_agent_loans(self, actor, space_id, task_id):
        rows, _, _ = await self.runtime.driver.execute_query(
            'MATCH (l:FuliAgentLoan {space:$space, task_id:$task}) SET l.serial=coalesce(l.serial,0)+1 '
            'RETURN l.record_json AS record_json', space=space_id, task=task_id)
        for row in rows:
            record = json.loads(row['record_json'])
            if record['status'] in ('requested', 'approved'):
                await self._close_agent_loan(actor, record)
