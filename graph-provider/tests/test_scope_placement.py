"""The scope write FULI makes for a person's decision (rec#11 D-86):
knowledge_scope_edit.place_scope_as on a synthetic driver."""
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph import knowledge_scope_edit
from fuli_graph.knowledge_item_view_models import KnowledgeItemScope, KnowledgeScopeProject
from fuli_graph.system_agents import SYSTEM_ASSISTANT_AGENT_ID

SPACE = {'id': 'synthetic-space', 'group_id': 'synthetic-group', 'kind': 'personal'}
TEMPORARY = 'temporary-' + 'a' * 64


class RevisionDriver:
    def __init__(self):
        self.revisions = []

    async def execute_query(self, query, **parameters):
        if 'FuliKnowledgeRevision' in query and 'CREATE' in query:
            self.revisions.append(parameters)
            return [], None, None
        if 'count(revision)' in query:
            return [{'revisions': 2}], None, None
        raise AssertionError(query)


@pytest.fixture
def scoped(monkeypatch):
    state = {'project': 'garden', 'writes': [], 'authorized': []}

    async def read_item(store, space, item_id, item_kind):
        return {'uuid': item_id}

    async def item_scope(store, space, item_kind, item_id, current):
        return KnowledgeItemScope(kind='temporary' if state['project'] == TEMPORARY else 'projects',
                                  projects=[KnowledgeScopeProject(id=state['project'],
                                                                  temporary=state['project'] == TEMPORARY)])

    async def authorize(store, actor, space, project_id):
        state['authorized'].append((actor['id'], project_id))
        return {'project_id': project_id, 'scope_type': 'temporary' if project_id == TEMPORARY else 'registered'}

    async def write_projects(store, author, space, item_id, item_kind, project_ids, *, current, reason,
                             scope_status=None):
        state['writes'].append((author['id'], project_ids, scope_status))
        state['project'] = project_ids[0]

    for name, value in (('_read_item', read_item), ('item_scope', item_scope),
                        ('authorize_personal_project', authorize), ('write_knowledge_projects', write_projects)):
        monkeypatch.setattr(knowledge_scope_edit, name, value)
    store = SimpleNamespace(runtime=SimpleNamespace(driver=RevisionDriver()))
    return store, state


@pytest.mark.asyncio
async def test_a_system_move_is_recorded_as_its_author_and_may_return_an_item_to_its_session(scoped):
    store, state = scoped
    moved = await knowledge_scope_edit.place_scope_as(
        store, {'id': 'principal'}, SPACE, SYSTEM_ASSISTANT_AGENT_ID, 'entity', 'gate',
        expected_version=2, project_ids=[TEMPORARY], reason='撤销话题「Garden」的升级', scope_status='undetermined')
    assert state['authorized'] == [('principal', TEMPORARY)], 'the space owner authorizes; the author records'
    assert state['writes'] == [(SYSTEM_ASSISTANT_AGENT_ID, [TEMPORARY], 'undetermined')]
    [revision] = store.runtime.driver.revisions
    assert revision['created_by'] == SYSTEM_ASSISTANT_AGENT_ID
    assert json.loads(revision['previous_json'])['scope']['projects'][0]['id'] == 'garden'
    assert json.loads(revision['current_json'])['scope']['kind'] == 'temporary'
    assert moved['scope']['projects'][0]['id'] == TEMPORARY


@pytest.mark.asyncio
async def test_a_system_move_keeps_the_stale_version_guard(scoped):
    store, state = scoped
    with pytest.raises(HTTPException) as error:
        await knowledge_scope_edit.place_scope_as(
            store, {'id': 'principal'}, SPACE, SYSTEM_ASSISTANT_AGENT_ID, 'entity', 'gate',
            expected_version=1, project_ids=['garden'], reason='synthetic')
    assert (error.value.status_code, error.value.detail['code']) == (409, 'stale_version')
    assert state['writes'] == [] and store.runtime.driver.revisions == []
