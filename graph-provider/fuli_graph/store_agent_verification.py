import json
from fastapi import HTTPException
from .agent_quality_policy import evaluate_quality_policy
from .personal_project_access import authorize_personal_project
from .project_agent_access import authorize_project_agent
from .project_agent_models import ProjectAgentModelStrategy
from .provider_values import now_utc, stable_uuid
from .store_transactions import query_store_transaction


class StoreAgentVerification:
    async def _quality_task(self, actor, request):
        self._require_personal()
        space = await self.authorize(actor, request.personal_space_id, 'maintainer')
        await authorize_personal_project(self, actor, space, request.personal_project_id)
        rows, _, _ = await self.runtime.driver.execute_query(
            'MATCH (t:FuliProjectAgentTask {task_id:$task, personal_space_id:$space, personal_project_id:$project}) RETURN t',
            task=request.task_id, space=request.personal_space_id, project=request.personal_project_id)
        if not rows:
            raise HTTPException(404, 'Quality gate task not found')
        return dict(rows[0]['t'])

    async def _quality_models(self, actor, request, task):
        executors = await self.list_project_agent_executors(actor, request.personal_space_id, available_only=True)
        models = []
        strategy = ProjectAgentModelStrategy.model_validate_json(task.get('effective_model_strategy_json') or '{}')
        policy = json.loads(task.get('executor_policy_json') or '{}')
        locked = policy.get('locked_executor_ids', []) if policy.get('mode') == 'locked' else None
        for executor in executors:
            if locked is not None and executor.executor_id not in locked:
                continue
            if (executor.permission_status != 'authorized' or executor.preflight_status != 'passed'
                or executor.registration_status != 'registered' or not executor.workspace_permission
                or executor.health_status == 'unhealthy'
                or (executor.health_required and executor.health_status != 'healthy')):
                continue
            for model in executor.available_models:
                if self._select_model([model], strategy) is not None:
                    models.append({**model.model_dump(), 'executor_id': executor.executor_id})
        return models

    async def query_agent_quality(self, actor, request):
        task = await self._quality_task(actor, request)
        rows, _, _ = await self.runtime.driver.execute_query(
            'MATCH (t:FuliProjectAgentTask {task_id:$task, personal_space_id:$space})-[:HAS_VERIFICATION]->(v:FuliAgentVerification) '
            'RETURN v.record_json AS record_json ORDER BY v.sequence', task=request.task_id, space=request.personal_space_id)
        models = await self._quality_models(actor, request, task)
        result = evaluate_quality_policy(complexity=task.get('complexity') or 'standard',
            current_strategy=json.loads(task.get('effective_model_strategy_json') or '{"mode":"adaptive"}'),
            artifact_revision=request.artifact_revision,
            attempts=[json.loads(row['record_json']) for row in rows], available_models=models)
        selected = result['selected_model']
        if selected:
            selected['executor_id'] = next(model['executor_id'] for model in models
                if all(model.get(key) == selected[key] for key in ('provider', 'model', 'capability_tier', 'cost_rank')))
        return {**result, 'evidence_authority': 'host_reported_test_evidence',
            'execution_started': False, 'guidance': 'Only complete the task after passed for the current artifact revision. Blocked means no authorized preflighted model proves the required capability tier. Model selection does not prove execution.'}

    async def record_agent_verification(self, actor, request):
        async with query_store_transaction(self) as store:
            task = await store._quality_task(actor, request)
            context = await store.get_task_context(actor, request.personal_space_id,
                request.task_context_token, request.source_application)
            if context['personal_project_id'] != request.personal_project_id or not context['project_agent_id']:
                raise HTTPException(403, 'Verifier needs a current Agent in the task project')
            space = await store.authorize(actor, request.personal_space_id, 'maintainer')
            verifier = await authorize_project_agent(store, actor, space, request.personal_project_id,
                context['project_agent_id'], require_active=True)
            if request.source_application not in json.loads(verifier['profile_json']).get('allowed_clients', []):
                raise HTTPException(403, 'Verifier is not allowed in this client')
            await store.runtime.driver.execute_query(
                'MATCH (t:FuliProjectAgentTask {task_id:$task, personal_space_id:$space}) '
                'SET t.verification_serial=coalesce(t.verification_serial,0)+1',
                task=request.task_id, space=request.personal_space_id)
            models = await store._quality_models(actor, request, task)
            observed = next((model for model in models if model['executor_id'] == request.executor_id
                and model['provider'] == request.provider and model['model'] == request.model), None)
            if not observed or not observed.get('capability_tier'):
                raise HTTPException(409, 'Verification model needs preflighted capability metadata')
            # A host must report a real execution, not just the configured model.
            execution, _, _ = await store.runtime.driver.execute_query(
                'MATCH (t:FuliProjectAgentTask {task_id:$task, personal_space_id:$space})-[:HAS_EXECUTOR_OBSERVATION]->'
                '(o:FuliProjectAgentExecutorObservation {agent_id:$agent, executor_id:$executor, provider:$provider, model:$model, run_id:$run, artifact_revision:$revision}) RETURN o LIMIT 1',
                task=request.task_id, space=request.personal_space_id, agent=context['project_agent_id'],
                executor=request.executor_id, provider=request.provider, model=request.model, run=request.run_id, revision=request.artifact_revision)
            if not execution:
                raise HTTPException(409, 'Report the verifier actual executor run before recording verification')
            used, _, _ = await store.runtime.driver.execute_query(
                'MATCH (t:FuliProjectAgentTask {task_id:$task, personal_space_id:$space})-[:HAS_VERIFICATION]->(v:FuliAgentVerification {run_id:$run}) '
                'RETURN v.attempt_id AS attempt_id', task=request.task_id, space=request.personal_space_id, run=request.run_id)
            if used and used[0]['attempt_id'] != request.attempt_id:
                raise HTTPException(409, 'An execution run cannot count as two verification attempts')
            identifier = stable_uuid('verification', request.personal_space_id, request.task_id, request.attempt_id)
            record = dict(attempt_id=request.attempt_id, outcome=request.outcome, artifact_revision=request.artifact_revision,
                evidence_refs=request.evidence_refs, capability_tier=observed['capability_tier'], verifier_id=context['project_agent_id'])
            fingerprint = store._payload_hash(request)
            rows, _, _ = await store.runtime.driver.execute_query(
                'MATCH (t:FuliProjectAgentTask {task_id:$task, personal_space_id:$space}) '
                'MERGE (v:FuliAgentVerification {id:$id}) ON CREATE SET v.record_json=$record, v.fingerprint=$fingerprint, '
                'v.sequence=t.verification_serial, v.created_at=$now, v.run_id=$run, v.attempt_id=$attempt '
                'MERGE (t)-[:HAS_VERIFICATION]->(v) RETURN v.fingerprint AS fingerprint',
                task=request.task_id, space=request.personal_space_id, id=identifier,
                record=json.dumps(record), fingerprint=fingerprint, now=now_utc().isoformat(), run=request.run_id, attempt=request.attempt_id)
            if rows[0]['fingerprint'] != fingerprint:
                raise HTTPException(409, 'Verification attempt ID has different evidence')
            result = await store.query_agent_quality(actor, request)
            await store.runtime.driver.execute_query(
                'MATCH (t:FuliProjectAgentTask {task_id:$task, personal_space_id:$space}) '
                'SET t.quality_gate=$status, t.verified_artifact_revision=$revision',
                task=request.task_id, space=request.personal_space_id, status=result['status'], revision=request.artifact_revision)
            return result
