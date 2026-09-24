import pytest

from fuli_graph.project_agent_executor_models import ProjectAgentExecutorModelRecord
from fuli_graph.project_agent_models import ProjectAgentExecutorPolicy, ProjectAgentModelStrategy, ProjectAgentProfile
from fuli_graph.project_agent_task_models import ProjectAgentTaskSubmit
from fuli_graph.store_project_agent_executor_routing import StoreProjectAgentExecutorRouting
from fuli_graph.store_project_agent_tasks import StoreProjectAgentTasks


def task(**updates):
    return ProjectAgentTaskSubmit(**{
        'personal_space_id': 'space', 'personal_project_id': 'project',
        'idempotency_key': 'task-key-123', 'title': 'Validate page',
        'objective': 'Validate a bounded page change.', 'work_kind': 'test_validation',
        'routing_reason': 'Match the task to a suitable executor.', **updates,
    })


@pytest.mark.parametrize(('complexity', 'mode'), [('simple', 'fast'), ('standard', 'balanced'), ('complex', 'deep')])
@pytest.mark.parametrize('source', ['task', 'assignment', 'agent', 'coordinator'])
def test_adaptive_strategy_resolves_complexity_after_precedence(complexity, mode, source):
    automatic = ProjectAgentModelStrategy(mode='adaptive', reasoning_effort='high', capability_hints=['testing'])
    selected = {'profile': ProjectAgentProfile(name='Verifier', responsibility='Verify work.', default_model_strategy=automatic)}
    request = task(complexity_hint=complexity)
    coordinator = ProjectAgentModelStrategy(mode='deep')
    if source == 'task':
        request = request.model_copy(update={'model_strategy_override': automatic})
        selected['model_strategy_override'] = ProjectAgentModelStrategy(mode='balanced')
    elif source == 'assignment':
        selected['model_strategy_override'] = automatic.model_dump_json()
    elif source == 'coordinator':
        selected = None
        coordinator = automatic
    strategy, provenance = StoreProjectAgentTasks._effective_model_strategy(request, selected, coordinator)
    assert (strategy.mode, provenance) == (mode, source)
    assert strategy.reasoning_effort == 'high'
    assert strategy.capability_hints == ['testing']
    assert automatic.mode == 'adaptive'


@pytest.mark.parametrize('mode', ['fast', 'balanced', 'deep'])
def test_explicit_nonadaptive_strategy_is_preserved_even_when_complexity_disagrees(mode):
    override = ProjectAgentModelStrategy(mode=mode, reasoning_effort='low')
    request = task(complexity_hint='complex', model_strategy_override=override)
    strategy, provenance = StoreProjectAgentTasks._effective_model_strategy(request, None, ProjectAgentModelStrategy())
    assert strategy == override
    assert provenance == 'task'


def test_automatic_complexity_assessment_is_used_when_no_hint_was_given():
    request = task(objective='A' * 1250, required_capabilities=['design', 'accessibility', 'testing', 'routing'])
    strategy, _ = StoreProjectAgentTasks._effective_model_strategy(request, None, ProjectAgentModelStrategy())
    assert strategy.mode == 'deep'


@pytest.mark.asyncio
async def test_complexity_strategy_reaches_model_selection_without_relaxing_executor_lock():
    class Store(StoreProjectAgentTasks):
        async def resolve_project_agent_executor(self, actor, **request):
            self.resolved = request
            return None

    store = Store()
    request = task(complexity_hint='complex', executor_policy_override=ProjectAgentExecutorPolicy(
        mode='locked', locked_executor_ids=['authorized-client']))
    selected = {'agent_id': 'agent', 'assignment_id': 'assignment'}
    strategy, source = store._effective_model_strategy(request, selected, ProjectAgentModelStrategy())
    await store._resolve_executor_if_available({}, request, selected, strategy, source, 'task')
    assert store.resolved['model_strategy'].mode == 'deep'
    assert store.resolved['task_override'].locked_executor_ids == ['authorized-client']
    models = [ProjectAgentExecutorModelRecord(provider='example', model=mode, strategy_modes=[mode], available=True)
              for mode in ('fast', 'balanced', 'deep')]
    picked = StoreProjectAgentExecutorRouting._select_model(models, store.resolved['model_strategy'])
    assert picked.model == 'deep'
