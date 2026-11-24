"""Remote origin proofs for each purpose, issued without a graph: the
authority's checks, what it signs, and that execution and chat proofs keep
the exact bytes they had before query and request existed. Synthetic only."""

import json
from base64 import urlsafe_b64decode
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from nacl.signing import SigningKey
from pydantic import ValidationError

from fuli_graph import project_agent_remote_origins as origins
from fuli_graph.project_agent_remote_origins import AgentRemoteOriginIssue, StoreRemoteAgentOrigins

FIXTURE = Path(__file__).with_name('remote_origin_proofs_before_purposes.json')
NOW = datetime(2026, 11, 14, 8, 0, 0, tzinfo=timezone.utc)
SEED = bytes(range(32))
LEAD, MEMBER = 'agent-lead', 'agent-member'


class FixedTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW


class Driver:
    """The authority's two graph reads: the locked task check and the origin key."""

    def __init__(self, store):
        self.store = store

    async def execute_query(self, query, **parameters):
        if 'FuliRemoteOriginKey' in query:
            public = bytes(SigningKey(SEED).verify_key)
            return [{'private_key': origins._encode(SEED), 'public_key': origins._encode(public),
                     'key_id': '0123456789abcdef0123456789abcdef'}], None, None
        # The locked check records the origin only when it is allowed; this
        # answers as that Cypher does for a live, assigned task.
        assert 'live_task AND (lead OR NOT $lead_required) AND assigned AS allowed' in query
        lead = parameters['agent_id'] == LEAD
        allowed = lead or not parameters['lead_required']
        return [{'live_task': True, 'lead': lead, 'assigned': True, 'same': allowed}], None, None


class Authority(StoreRemoteAgentOrigins):
    def __init__(self, agent_id=LEAD, context=None):
        self.runtime = SimpleNamespace(driver=Driver(self))
        self.agent_id = agent_id
        self.context = context or {}

    def _require_personal(self):
        return None

    async def authorize(self, actor, space_id, role):
        del actor, role
        return {'id': space_id, 'kind': 'personal', 'group_id': space_id}

    async def get_task_context(self, actor, space_id, token, source_application):
        del actor, space_id, token, source_application
        return {'project_agent_id': self.agent_id, 'personal_project_id': 'project-fixture', **self.context}

    async def get_project_agent_coordination_policy(self, actor, space_id, project_id):
        del actor, space_id, project_id
        return SimpleNamespace(team_lead_agent_id=LEAD)

    async def get_project_agent(self, actor, space_id, project_id, agent_id):
        del actor, space_id, project_id
        return SimpleNamespace(profile=SimpleNamespace(status='active', display_name=None, name=agent_id))


def request(purpose=None):
    fields = dict(personal_space_id='space-fixture', task_context_token='task-fixture', source_application='codex',
                  message_id='message-fixture', digest='d' * 64, target_node='e' * 64, binding_id='binding-fixture',
                  expires_at='2026-11-14T08:10:00.000Z')
    return AgentRemoteOriginIssue(**fields, **({'purpose': purpose} if purpose else {}))


@pytest.fixture(autouse=True)
def fixed_time(monkeypatch):
    monkeypatch.setattr(origins, 'datetime', FixedTime)

    async def authorized(*args, **kwargs):
        del args, kwargs
    monkeypatch.setattr(origins, 'authorize_personal_project', authorized)


async def issue(purpose=None, agent_id=LEAD, context=None):
    return await Authority(agent_id, context).issue_remote_agent_origin({'id': 'actor'}, request(purpose))


def claims(issued):
    return json.loads(urlsafe_b64decode(issued['proof']['payload'] + '=' * (-len(issued['proof']['payload']) % 4)))


async def test_execution_and_chat_proofs_keep_their_bytes():
    expected = json.loads(FIXTURE.read_text(encoding='utf-8'))
    assert (await issue())['proof'] == expected['default']
    assert (await issue('execution'))['proof'] == expected['execution']
    assert (await issue('chat'))['proof'] == expected['chat']


@pytest.mark.parametrize('purpose', ['query', 'request'])
async def test_a_query_or_request_proof_signs_its_purpose_under_its_own_version(purpose):
    signed = claims(await issue(purpose))
    assert signed['purpose'] == purpose
    assert signed['version'] == f'fuli-{purpose}-origin/1'


async def test_any_agent_of_a_live_task_may_issue_a_query_but_only_the_lead_a_request():
    assert claims(await issue('query', agent_id=MEMBER))['agent_id'] == MEMBER
    for purpose in ('execution', 'request'):
        with pytest.raises(HTTPException) as refused:
            await issue(purpose, agent_id=MEMBER)
        assert refused.value.status_code == 403


@pytest.mark.parametrize('purpose', ['chat', 'query', 'request'])
@pytest.mark.parametrize('context', [{'agent_memory_scope': 'task_only'}, {'turn_id': 'worker-run:1'}])
async def test_a_restricted_worker_cannot_reach_another_computer(purpose, context):
    with pytest.raises(HTTPException) as refused:
        await issue(purpose, context=context)
    assert refused.value.status_code == 403


def test_a_remote_origin_names_one_known_purpose():
    for purpose in ('execution', 'chat', 'query', 'request'):
        assert request(purpose).purpose == purpose
    assert request().purpose == 'execution'
    with pytest.raises(ValidationError):
        request('trusted')
