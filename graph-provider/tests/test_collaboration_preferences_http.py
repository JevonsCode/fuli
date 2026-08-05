import json
import os
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest

os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'test-password')

from fuli_graph.app import create_app
from fuli_graph.config import Settings


@pytest.mark.asyncio
async def test_child_receives_two_parent_preferences_with_provenance_over_http():
    driver = SequentialDriver([
        [{'project': {'project_id': 'travel-d'}}],
        [
            {
                'project_id': 'platform-a',
                'scope_path': ['travel-d', 'platform-a'],
                'scope_distance': 1,
            },
            {
                'project_id': 'platform-b',
                'scope_path': ['travel-d', 'platform-b'],
                'scope_distance': 1,
            },
        ],
        [
            preference_node(
                'parent-a-preference',
                'alignment.network.parent-a.explain-boundary',
                '提出实现建议前先解释功能边界。',
                'platform-a',
                weight=0.85,
                reason='A 的项目约定明确要求解释功能边界。',
            ),
            preference_node(
                'parent-b-preference',
                'alignment.network.parent-b.rollback-path',
                '提出方案时同时说明回退路径。',
                'platform-b',
                weight=0.7,
                reason='B 的项目约定明确要求说明回退路径。',
            ),
        ],
        [],
    ])
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)

    async def authenticate(token):
        assert token == 'test-access-token'
        return {'id': 'principal-1'}

    async def authorize(actor, space_id, role):
        assert actor == {'id': 'principal-1'}
        assert (space_id, role) == ('personal-space', 'reader')
        return {
            'id': 'personal-space',
            'kind': 'personal',
            'group_id': 'personal-group',
        }

    store.authenticate = authenticate
    store.authorize = authorize

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
    ) as client:
        response = await client.get(
            '/v1/collaboration-preferences',
            params={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
            },
            headers={'authorization': 'Bearer test-access-token'},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    inherited = {
        item['preference_key']: item
        for item in body['effective_preferences']
    }
    assert set(inherited) == {
        'alignment.network.parent-a.explain-boundary',
        'alignment.network.parent-b.rollback-path',
    }
    assert inherited['alignment.network.parent-a.explain-boundary'] == {
        **inherited['alignment.network.parent-a.explain-boundary'],
        'preference_project_id': 'platform-a',
        'inherited_from_project_id': 'platform-a',
        'scope_distance': 1,
        'scope_path': ['travel-d', 'platform-a'],
        'weight': 0.85,
        'reason': 'A 的项目约定明确要求解释功能边界。',
    }
    assert inherited['alignment.network.parent-b.rollback-path']['scope_path'] == [
        'travel-d',
        'platform-b',
    ]
    scope_query = driver.calls[1][0]
    assert "['PART_OF', 'USES_KNOWLEDGE_FROM']" in scope_query
    assert 'PERSONAL_PROJECT_RELATION*1..2' in scope_query
    assert 'RELATED_TO' not in scope_query


@pytest.mark.asyncio
async def test_child_same_key_preference_overrides_parent_without_losing_audit_item():
    driver = SequentialDriver([
        [{'project': {'project_id': 'travel-d'}}],
        [{
            'project_id': 'platform-a',
            'scope_path': ['travel-d', 'platform-a'],
            'scope_distance': 1,
        }],
        [
            preference_node(
                'child-comment-language',
                'alignment.comments.explain-function',
                '注释要用中文写清楚功能。',
                'travel-d',
                weight=0.4,
                reason='D 的局部约束由用户明确确认。',
            ),
            preference_node(
                'parent-comment-style',
                'alignment.comments.explain-function',
                '注释要写清楚功能。',
                'platform-a',
                weight=0.99,
                reason='A 的共享偏好权重更高但作用域更远。',
            ),
        ],
        [],
    ])
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)
    store.authenticate = async_value({'id': 'principal-1'})
    store.authorize = async_value({
        'id': 'personal-space',
        'kind': 'personal',
        'group_id': 'personal-group',
    })

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
    ) as client:
        response = await client.get(
            '/v1/collaboration-preferences',
            params={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
            },
            headers={'authorization': 'Bearer test-access-token'},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert [item['id'] for item in body['effective_preferences']] == [
        'child-comment-language',
    ]
    assert {item['id'] for item in body['project_preferences']} == {
        'child-comment-language',
        'parent-comment-style',
    }
    assert body['overridden_inherited_ids'] == ['parent-comment-style']
    assert body['conflicts'] == []


@pytest.mark.asyncio
async def test_parent_preference_requires_explicit_inheritance_authorization():
    driver = SequentialDriver([
        [{'project': {'project_id': 'travel-d'}}],
        [{
            'project_id': 'platform-a',
            'scope_path': ['travel-d', 'platform-a'],
            'scope_distance': 1,
        }],
        [
            preference_node(
                'parent-local-only',
                'parent.local-only',
                '只在 A 使用。',
                'platform-a',
                weight=1,
                reason='用户明确限制为 A 本地。',
                inheritance_mode='local_only',
            ),
            preference_node(
                'parent-descendants',
                'parent.descendants',
                '所有后代项目使用。',
                'platform-a',
                weight=0.5,
                reason='用户明确允许后代继承。',
                inheritance_mode='descendants',
            ),
            preference_node(
                'parent-selected-travel',
                'parent.selected.travel',
                '只授权 D 使用。',
                'platform-a',
                weight=0.5,
                reason='用户明确选择 D。',
                inheritance_mode='selected_projects',
                inherited_project_ids=['travel-d'],
            ),
            preference_node(
                'parent-selected-other',
                'parent.selected.other',
                '只授权其他项目使用。',
                'platform-a',
                weight=0.5,
                reason='用户没有授权 D。',
                inheritance_mode='selected_projects',
                inherited_project_ids=['other-project'],
            ),
        ],
        [],
    ])
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)
    store.authenticate = async_value({'id': 'principal-1'})
    store.authorize = async_value({
        'id': 'personal-space',
        'kind': 'personal',
        'group_id': 'personal-group',
    })

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
    ) as client:
        response = await client.get(
            '/v1/collaboration-preferences',
            params={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
            },
            headers={'authorization': 'Bearer test-access-token'},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert {item['id'] for item in body['effective_preferences']} == {
        'parent-descendants',
        'parent-selected-travel',
    }
    assert {item['id'] for item in body['project_preferences']} == {
        'parent-descendants',
        'parent-selected-travel',
    }


@pytest.mark.asyncio
async def test_human_confirmed_parent_outranks_agent_confirmed_child():
    driver = SequentialDriver([
        [{'project': {'project_id': 'travel-d'}}],
        [{
            'project_id': 'platform-a',
            'scope_path': ['travel-d', 'platform-a'],
            'scope_distance': 1,
        }],
        [
            preference_node(
                'child-agent-tone',
                'shared.tone',
                '使用轻松语气。',
                'travel-d',
                weight=1,
                reason='Agent 根据用量保留。',
                inheritance_mode='local_only',
                confirmation_status='agent_confirmed',
            ),
            preference_node(
                'parent-human-tone',
                'shared.tone',
                '使用正式语气。',
                'platform-a',
                weight=0.1,
                reason='用户明确确认父项目偏好。',
                inheritance_mode='descendants',
                confirmation_status='confirmed',
            ),
        ],
        [],
    ])
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)
    store.authenticate = async_value({'id': 'principal-1'})
    store.authorize = async_value({
        'id': 'personal-space',
        'kind': 'personal',
        'group_id': 'personal-group',
    })

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
    ) as client:
        response = await client.get(
            '/v1/collaboration-preferences',
            params={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
            },
            headers={'authorization': 'Bearer test-access-token'},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert [item['id'] for item in body['effective_preferences']] == [
        'parent-human-tone',
    ]
    assert body['overridden_inherited_ids'] == []
    assert body['overridden_lower_authority_ids'] == ['child-agent-tone']


@pytest.mark.asyncio
async def test_human_confirmed_global_outranks_agent_confirmed_local_project():
    driver = SequentialDriver([
        [{'project': {'project_id': 'travel-d'}}],
        [],
        [
            preference_node(
                'global-human-tone',
                'shared.tone',
                '使用正式语气。',
                None,
                weight=0.1,
                reason='用户明确确认个人全局偏好。',
                confirmation_status='confirmed',
            ),
            preference_node(
                'child-agent-tone',
                'shared.tone',
                '使用轻松语气。',
                'travel-d',
                weight=1,
                reason='Agent 根据用量保留。',
                inheritance_mode='local_only',
                confirmation_status='agent_confirmed',
            ),
        ],
        [],
    ])
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)
    store.authenticate = async_value({'id': 'principal-1'})
    store.authorize = async_value({
        'id': 'personal-space',
        'kind': 'personal',
        'group_id': 'personal-group',
    })

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
    ) as client:
        response = await client.get(
            '/v1/collaboration-preferences',
            params={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
            },
            headers={'authorization': 'Bearer test-access-token'},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert [item['id'] for item in body['effective_preferences']] == [
        'global-human-tone',
    ]
    assert body['overridden_global_ids'] == []
    assert body['overridden_lower_authority_ids'] == ['child-agent-tone']


@pytest.mark.asyncio
async def test_effective_exact_project_override_suppresses_global_conflict_only():
    driver = SequentialDriver([
        [{'project': {'project_id': 'travel-d'}}],
        [],
        [
            preference_node(
                'global-tone-formal',
                'shared.tone',
                '使用正式语气。',
                None,
                weight=0.9,
                reason='旧的个人全局判断 A。',
            ),
            preference_node(
                'global-tone-casual',
                'shared.tone',
                '使用轻松语气。',
                None,
                weight=0.1,
                reason='旧的个人全局判断 B。',
            ),
            preference_node(
                'local-tone-direct',
                'shared.tone',
                '在 D 中使用直接语气。',
                'travel-d',
                weight=0.5,
                reason='用户明确确认 D 的精确局部覆盖。',
                inheritance_mode='local_only',
            ),
        ],
        [],
    ])
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)
    store.authenticate = async_value({'id': 'principal-1'})
    store.authorize = async_value({
        'id': 'personal-space',
        'kind': 'personal',
        'group_id': 'personal-group',
    })

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
    ) as client:
        response = await client.get(
            '/v1/collaboration-preferences',
            params={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
            },
            headers={'authorization': 'Bearer test-access-token'},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert [item['id'] for item in body['effective_preferences']] == [
        'local-tone-direct',
    ]
    assert body['conflicts'] == []
    assert body['overridden_global_ids'] == [
        'global-tone-casual',
        'global-tone-formal',
    ]
    assert {item['id'] for item in body['global_preferences']} == {
        'global-tone-casual',
        'global-tone-formal',
    }


class SequentialDriver:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return self.responses.pop(0), None, None


def async_value(value):
    async def resolve(*_args, **_kwargs):
        return value

    return resolve


def preference_node(
    item_id,
    preference_key,
    instruction,
    project_id,
    *,
    weight,
    reason,
    inheritance_mode='descendants',
    inherited_project_ids=None,
    confirmation_status='confirmed',
):
    return {
        'id': item_id,
        'key': preference_key,
        'title': preference_key,
        'instruction': instruction,
        'profile_aspect': 'judgment_preference',
        'preference_scope': 'project' if project_id else 'global',
        'preference_project_id': project_id,
        'attributes_json': json.dumps({
            'preferenceKey': preference_key,
            'weight': weight,
            'reason': reason,
        }),
        'confirmation_basis_json': json.dumps({
            'existence_reason': reason,
            'quadrant_reason': reason,
            'proposed_by': {'kind': 'user', 'label': '用户'},
            'confirmed_by': (
                {'kind': 'agent', 'label': 'Fuli usage policy'}
                if confirmation_status == 'agent_confirmed'
                else {'kind': 'user', 'label': '用户'}
            ),
            'confirmed_at': '2026-08-03T00:00:00Z',
            **(
                {'agent_policy_version': 'agent-usage-v1'}
                if confirmation_status == 'agent_confirmed'
                else {}
            ),
        }),
        'confirmation_status': confirmation_status,
        'inheritance_mode': inheritance_mode,
        'inherited_project_ids': inherited_project_ids or [],
        'created_at': datetime(2026, 8, 3, tzinfo=UTC),
    }
