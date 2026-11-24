"""The entries that write `global` ask who calls before they refuse a copy
(docs/runner-roles-design.md §12, "Write refusal"): a caller the space does not
admit hears 403, never whether `global` is a copy here; an admitted caller on a
follower hears 409 replica_read_only before anything is read or written; on a
graph whose `global` is its own, the same call goes on to the graph as before.

No Neo4j: the graph is a double that fails the test if anything reaches it.
"""
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph.config import Settings
from fuli_graph.knowledge_tags import add_tag_alias
from fuli_graph.owner_hire import OwnerHireRequest, hire_for_owner_recruitment
from fuli_graph.project_agent_models import ProjectAgentProfile, ProjectAgentUpsert
from fuli_graph.project_agent_occupation_models import ProjectAgentOccupationInput
from fuli_graph.replica_write_guard import ReplicaWriteGuard
from fuli_graph.store import GraphStore

SPACE = '0f0e0d0c-0b0a-4909-8807-060504030201'
ACTOR = {'id': 'synthetic-caller'}
PROFILE = ProjectAgentProfile(name='Synthetic writer', responsibility='Write the synthetic sample.')
REQUEST = SimpleNamespace(personal_space_id=SPACE, personal_project_id=None, topic='Synthetic topic',
                          role='engineering', reason='Synthetic.', keep=[], renames={})


class Reached(Exception):
    """The call went on to the graph."""


class _Graph:
    def __init__(self, global_replica):
        self.replica_guard = ReplicaWriteGuard(global_replica)

    async def execute_query(self, *_, **__):
        raise Reached

    @asynccontextmanager
    async def transaction(self):
        yield self

    async def run(self, *_, **__):
        raise Reached


def store(*, global_replica, admitted):
    settings = Settings(bootstrap_token='test-bootstrap-token-1234', neo4j_password='test-password',
                        provider_mode='personal', global_replica=global_replica)
    graph_store = GraphStore(SimpleNamespace(driver=_Graph(global_replica)), settings)

    async def authorize(actor, space_id, role):
        if not admitted:
            raise HTTPException(403, 'not a member of this personal space')
        return {'id': space_id, 'kind': 'personal', 'group_id': 'synthetic-group'}
    graph_store.authorize = authorize
    return graph_store


ENTRIES = {
    "rename an FLA": lambda s: s.rename_project_agent(ACTOR, 'synthetic-writer', REQUEST),
    "write an FLA's global memory": lambda s: s.write_project_agent_memory(ACTOR, REQUEST),
    'add an occupation': lambda s: s.create_occupation(ACTOR, REQUEST),
    'change an occupation': lambda s: s.update_occupation(ACTOR, 'custom_synthetic', REQUEST),
    'dismiss an FLA': lambda s: s.dismiss_project_agent(ACTOR, 'synthetic-writer', REQUEST),
    'archive a test FLA': lambda s: s.archive_test_project_agent(ACTOR, SPACE, 'synthetic-writer',
                                                                 reason='Synthetic.'),
    'archive test FLAs': lambda s: s.archive_test_project_agents(ACTOR, SPACE, test_source='synthetic'),
    "fix FLAs' names": lambda s: s.apply_agent_name_fixes(ACTOR, REQUEST),
    "change an FLA's occupation": lambda s: s.update_project_agent_occupation(ACTOR, 'synthetic-writer', REQUEST),
    'make an FLA': lambda s: s.upsert_project_agent(ACTOR, ProjectAgentUpsert(
        personal_space_id=SPACE, agent_id='synthetic-writer', profile=PROFILE,
        occupation=ProjectAgentOccupationInput(role='engineering'))),
    'decline a conversation topic': lambda s: s.decline_conversation_topic(ACTOR, REQUEST),
    'draft a publication': lambda s: s.create_publication_draft(ACTOR, REQUEST),
    'keep a publication draft personal': lambda s: s.decide_publication_draft(
        ACTOR, SPACE, 'synthetic-draft', SimpleNamespace(decision='keep_personal')),
    'submit a publication draft': lambda s: s.decide_publication_submission(
        ACTOR, SPACE, 'synthetic-draft', SimpleNamespace(decision='submit')),
    'subscribe': lambda s: s.subscribe(ACTOR, REQUEST),
    'unsubscribe': lambda s: s.unsubscribe(ACTOR, SPACE, 'synthetic-project', 'https://provider.example.test'),
    'make an FLA for a follower': lambda s: hire_for_owner_recruitment(s, ACTOR, OwnerHireRequest(
        personal_space_id=SPACE, recruitment_id='synthetic-recruitment', agent_id='synthetic-writer',
        profile=PROFILE, occupation=ProjectAgentOccupationInput(role='engineering'), reason='Synthetic.',
        origin_computer='Synthetic laptop', origin_project='Synthetic project')),
}
# Not refused up front on a follower (an approval waits for the owner; an alias of a
# project tag is the project's), but asked who calls first all the same.
ALSO_AUTHORIZED_FIRST = {
    'decide a recruitment': lambda s: s.decide_project_agent_recruitment(ACTOR, SimpleNamespace(
        personal_space_id=SPACE, personal_project_id='synthetic-project', occupation=None, decision='approve')),
    'alias a tag': lambda s: add_tag_alias(s, ACTOR, SimpleNamespace(
        personal_space_id=SPACE, personal_project_id=None, operation_actor='agent', alias='Synthetic',
        tag_id='synthetic-tag')),
}


@pytest.mark.asyncio
@pytest.mark.parametrize('entry', [*ENTRIES, *ALSO_AUTHORIZED_FIRST])
async def test_a_caller_the_space_does_not_admit_hears_403_not_whether_global_is_a_copy(entry):
    call = ENTRIES.get(entry) or ALSO_AUTHORIZED_FIRST[entry]
    for global_replica in (True, False):
        with pytest.raises(HTTPException) as caught:
            await call(store(global_replica=global_replica, admitted=False))
        assert caught.value.status_code == 403, (entry, global_replica, caught.value.detail)


@pytest.mark.asyncio
@pytest.mark.parametrize('entry', ENTRIES)
async def test_an_admitted_caller_on_a_follower_is_refused_before_anything_is_read(entry):
    with pytest.raises(HTTPException) as caught:
        await ENTRIES[entry](store(global_replica=True, admitted=True))
    assert caught.value.status_code == 409, (entry, caught.value.detail)
    assert caught.value.detail['code'] == 'replica_read_only', entry


@pytest.mark.asyncio
@pytest.mark.parametrize('entry', ENTRIES)
async def test_where_global_is_its_own_the_same_call_goes_on_as_before(entry):
    try:
        await ENTRIES[entry](store(global_replica=False, admitted=True))
    except (Reached, HTTPException, AttributeError, TypeError) as error:
        # It went past the refusal (a double request stops it further on): never a copy's refusal.
        assert not (isinstance(error, HTTPException) and isinstance(error.detail, dict)
                    and error.detail.get('code') == 'replica_read_only'), entry
