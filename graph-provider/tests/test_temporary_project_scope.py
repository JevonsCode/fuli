import hashlib
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from fuli_graph.store_records import StoreRecords
from fuli_graph.store_transactions import TransactionQueryDriver
from fuli_graph.temporary_project_scope import (
    TEMPORARY_SCOPE, TemporaryProjectEnsure, ensure_temporary_project,
)
from fuli_graph.task_context_adoption import adopt_task_agent
from fuli_graph.task_context_models import TaskContextAdoptAgent


def request(token=None, source='codex', space='space-a'):
    key = hashlib.sha256(json.dumps(['fuli-temporary-task-v1', space, source, token, None],
        separators=(',', ':')).encode()).hexdigest()
    return TemporaryProjectEnsure(personal_space_id=space, scope_key=key,
        source_application=source, task_context_token=token)


class Result:
    def __init__(self, rows):
        self.rows = rows

    def __aiter__(self):
        self.iterator = iter(self.rows)
        return self

    async def __anext__(self):
        try:
            return next(self.iterator)
        except StopIteration:
            raise StopAsyncIteration


class Transaction:
    def __init__(self):
        self.calls = []
        self.project = None
        self.context = None
        self.reject_bind = False

    async def run(self, query, **values):
        self.calls.append((query, values))
        if 'RETURN context.record_json' in query:
            if self.reject_bind:
                return Result([])
            self.context = json.loads(values['record_json'])
            return Result([{'record_json': values['record_json']}])
        if 'RETURN project' in query:
            if self.project is None:
                self.project = {'project_id': values['project_id'], 'scope_type': 'temporary',
                    'publication_key': values['publication_key'], 'profile_json': values['profile_json'],
                    'created_at': values['now'], 'updated_at': values['now']}
            return Result([{'project': self.project}])
        raise AssertionError(query)


class Store(StoreRecords):
    def __init__(self, context=None):
        self.tx = Transaction()
        self.tx.context = context
        self.runtime = SimpleNamespace(driver=TransactionQueryDriver(self.tx))
        self.settings = SimpleNamespace(provider_id='synthetic')
        self.authorizations = []

    def _require_personal(self):
        pass

    async def authorize(self, actor, space, role):
        self.authorizations.append((actor, space, role))
        return {'id': space, 'kind': 'personal'}

    async def get_task_context(self, actor, space, token, source):
        if source != self.tx.context['source_application']:
            raise HTTPException(404, 'Task context not found for this client')
        return dict(self.tx.context)


def context(**changes):
    return {'personal_project_id': None, 'project_agent_id': None, 'checkpoint': None,
        'source_application': 'codex', 'token': 'fuli-task-12345678', **changes}


@pytest.mark.asyncio
async def test_temporary_project_is_replayed_without_changing_profile_or_history():
    store = Store()
    first = await ensure_temporary_project(store, {'id': 'actor'}, request())
    second = await ensure_temporary_project(store, {'id': 'actor'}, request())
    assert first == second
    assert first.scope_type == 'temporary'
    assert first.project_id.startswith('temporary-')
    assert store.authorizations[0][2] == 'maintainer'
    query = store.tx.calls[0][0]
    assert 'ON CREATE SET' in query
    assert 'DELETE' not in query


@pytest.mark.asyncio
async def test_scope_binds_only_its_current_empty_context_and_retry_preserves_it():
    store = Store(context())
    value = request('fuli-task-12345678')
    project = await ensure_temporary_project(store, {}, value)
    assert store.tx.context['personal_project_id'] == project.project_id
    assert store.tx.context['project_scope'] == TEMPORARY_SCOPE
    assert await ensure_temporary_project(store, {}, value) == project
    assert sum('SET context.personal_project_id' in query for query, _ in store.tx.calls) == 1
    serialized = json.dumps(store.tx.calls, default=str)
    assert 'projectPath' not in serialized and 'taskPrompt' not in serialized


@pytest.mark.asyncio
@pytest.mark.parametrize('changes', [
    {'personal_project_id': 'registered'}, {'project_agent_id': 'someone'},
    {'checkpoint': {'phase': 'prepare'}},
])
async def test_scope_cannot_replace_existing_project_owner_or_checkpoint(changes):
    store = Store(context(**changes))
    with pytest.raises(HTTPException) as caught:
        await ensure_temporary_project(store, {}, request('fuli-task-12345678'))
    assert caught.value.status_code == 409
    assert store.tx.calls == []


@pytest.mark.asyncio
async def test_scope_rejects_context_key_from_another_space_or_source():
    store = Store(context())
    wrong_key = request('fuli-task-12345678').model_copy(update={'personal_space_id': 'space-b'})
    with pytest.raises(HTTPException) as caught:
        await ensure_temporary_project(store, {}, wrong_key)
    assert caught.value.status_code == 409
    assert store.tx.calls == []


@pytest.mark.asyncio
async def test_context_compare_and_set_conflict_prevents_project_creation():
    store = Store(context())
    store.tx.reject_bind = True
    with pytest.raises(HTTPException) as caught:
        await ensure_temporary_project(store, {}, request('fuli-task-12345678'))
    assert caught.value.status_code == 409
    assert store.tx.project is None


def test_temporary_scope_contract_cannot_receive_raw_directory_or_prompt():
    for extra in [{'project_path': 'C:/private'}, {'task_prompt': 'secret'}, {'scope_key': 'raw-session'}]:
        with pytest.raises(ValidationError):
            TemporaryProjectEnsure.model_validate({**request().model_dump(), **extra})


@pytest.mark.asyncio
async def test_temporary_agent_adoption_requires_same_task_and_never_reads_long_term_memory(monkeypatch):
    async def authorize(*args, **kwargs):
        assert not kwargs.get('require_memory')
        return {'profile_json': json.dumps({'allowed_clients': ['codex']}),
            'memory_scope': 'task_only', 'temporary_task_id': 'task-one'}
    monkeypatch.setattr('fuli_graph.task_context_adoption.authorize_project_agent', authorize)
    store = Store(context(personal_project_id='project-one', project_scope=TEMPORARY_SCOPE))
    claim = TaskContextAdoptAgent(personal_space_id='space-a', personal_project_id='project-one',
        source_application='codex', task_id='task-one', agent_id='temporary-agent')
    with pytest.raises(HTTPException) as caught:
        await adopt_task_agent(store, {}, 'fuli-task-12345678', claim.model_copy(update={'task_id': 'task-two'}))
    assert caught.value.status_code == 409
    result = await adopt_task_agent(store, {}, 'fuli-task-12345678', claim)
    assert result['agent_memory_scope'] == 'task_only'
    assert result['memory_revision'] is None
    assert result['work_log_required'] is True
    assert result['project_agent_id'] == 'temporary-agent'
