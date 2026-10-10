import asyncio
import json
from types import SimpleNamespace

from fuli_graph.project_agent_executor_models import ProjectAgentExecutorModelRecord
from fuli_graph.store_agent_verification import StoreAgentVerification
from fuli_graph.store_project_agent_executor_routing import StoreProjectAgentExecutorRouting


def test_quality_models_use_the_same_strategy_capability_and_health_rules_as_execution():
    class Store(StoreAgentVerification, StoreProjectAgentExecutorRouting):
        async def list_project_agent_executors(self, *args, **kwargs):
            base = dict(permission_status='authorized', preflight_status='passed', registration_status='registered',
                        workspace_permission=True, health_required=False, health_status='healthy')
            def model(name, **kw):
                return ProjectAgentExecutorModelRecord(provider='synthetic', model=name, capability_tier=3, cost_rank=1, **kw)
            models = [model('fast-only', strategy_modes=['fast']), model('wrong-effort', reasoning_efforts=['low']),
                      model('no-capability'), model('qualified', strategy_modes=['deep'], reasoning_efforts=['high'], capabilities=['coding'])]
            return [SimpleNamespace(**base, executor_id='allowed', available_models=models),
                    SimpleNamespace(**{**base,'health_status':'unhealthy'}, executor_id='broken',available_models=[models[-1]]),
                    SimpleNamespace(**base, executor_id='outside-lock',available_models=[models[-1]])]
    request = SimpleNamespace(personal_space_id='space')
    task = dict(effective_model_strategy_json=json.dumps(dict(mode='deep', reasoning_effort='high', capability_hints=['coding'])),
                executor_policy_json=json.dumps(dict(mode='locked', locked_executor_ids=['allowed','broken'])))
    models = asyncio.run(Store()._quality_models({},request,task))
    assert [(m['executor_id'],m['model']) for m in models] == [('allowed','qualified')]


def test_quality_gate_exposes_only_the_actual_current_verified_attempt():
    attempt = dict(attempt_id='attempt', outcome='pass', artifact_revision='artifact', evidence_refs=['test-report'],
                   capability_tier=1, verifier_id='reviewer', executor_id='executor', provider='synthetic', model='observed')
    class Driver:
        async def execute_query(self, *args, **kwargs):
            return [{'record_json': json.dumps(attempt), 'run_id': 'actual-run'}], None, None
    class Store(StoreAgentVerification):
        runtime = SimpleNamespace(driver=Driver())
        async def _quality_task(self, *args):
            return {'complexity': 'simple'}
        async def _quality_models(self, *args):
            return []
    request = SimpleNamespace(task_id='task', personal_space_id='space', artifact_revision='artifact')
    gate = asyncio.run(Store().query_agent_quality({}, request))
    assert gate['verified_attempt']['run_id'] == 'actual-run'
    assert gate['verified_attempt']['verifier_id'] == 'reviewer'
    request.artifact_revision = 'changed'
    assert asyncio.run(Store().query_agent_quality({}, request))['verified_attempt'] is None
