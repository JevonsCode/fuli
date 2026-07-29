import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from fuli_graph.collaboration_context import read_collaboration_context


@pytest.mark.asyncio
async def test_collaboration_context_layers_exact_project_and_suppresses_conflicts():
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-a'}}],
        [
            preference_node(
                'global-density',
                'global.ui-density',
                '全局界面密度',
                '默认使用舒适密度。',
                preference_key='ui-density',
            ),
            preference_node(
                'project-density',
                'project.ui-density',
                '项目界面密度',
                '这个项目使用紧凑密度。',
                scope='project',
                project_id='project-a',
                preference_key='ui-density',
            ),
            preference_node(
                'tone-a',
                'tone-a',
                '表达语气',
                '使用正式语气。',
                preference_key='tone',
            ),
            preference_node(
                'tone-b',
                'tone-b',
                '表达语气',
                '使用轻松语气。',
                preference_key='tone',
            ),
            preference_node(
                'global-risk',
                'global-risk',
                '风险偏好',
                '默认选择低风险路径。',
                preference_key='risk',
            ),
            preference_node(
                'project-risk-a',
                'project-risk-a',
                '项目风险偏好',
                '这个项目优先速度。',
                scope='project',
                project_id='project-a',
                preference_key='risk',
            ),
            preference_node(
                'project-risk-b',
                'project-risk-b',
                '项目风险偏好',
                '这个项目优先稳定。',
                scope='project',
                project_id='project-a',
                preference_key='risk',
            ),
            preference_node('signature-source', 'signature-source', '署名规则', '添加署名。'),
            preference_node('signature-target', 'signature-target', '评论回复', '适用场景。'),
            {
                **preference_node(
                    'legacy-unconfirmed',
                    'legacy-unconfirmed',
                    '旧偏好',
                    '没有审计确认，不应生效。',
                ),
                'confirmation_basis_json': None,
            },
        ],
        [{
            'id': 'signature-edge',
            'key': 'signature.reply',
            'source_id': 'signature-source',
            'target_id': 'signature-target',
            'source_name': '署名规则',
            'target_name': '评论回复',
            'instruction': '代为回复评论时追加指定署名。',
            'profile_aspect': 'judgment_preference',
            'preference_scope': 'global',
            'preference_project_id': None,
            'attributes_json': json.dumps({'preferenceKey': 'reply-signature'}),
            'confirmation_basis_json': confirmation_basis(),
            'created_at': datetime(2026, 7, 28, 9, 0, tzinfo=UTC),
        }],
    ])
    store = StoreStub(driver)

    result = await read_collaboration_context(
        store,
        {'id': 'principal-1'},
        'personal-space',
        'project-a',
        100,
    )

    assert {item.id for item in result.global_preferences} == {
        'global-density',
        'tone-a',
        'tone-b',
        'global-risk',
        'signature-edge',
    }
    assert {item.id for item in result.project_preferences} == {
        'project-density',
        'project-risk-a',
        'project-risk-b',
    }
    assert {item.id for item in result.effective_preferences} == {
        'project-density',
        'signature-edge',
    }
    assert set(result.overridden_global_ids) == {'global-density', 'global-risk'}
    assert {conflict.preference_key for conflict in result.conflicts} == {'tone', 'risk'}
    conflicts = {conflict.preference_key: conflict for conflict in result.conflicts}
    assert set(conflicts['tone'].item_ids) == {'tone-a', 'tone-b'}
    assert set(conflicts['risk'].item_ids) == {'project-risk-a', 'project-risk-b'}
    assert result.truncated is False
    assert 'node.fuli_preference_project_id = $project_id' in driver.calls[1][0]
    assert 'edge.fuli_preference_project_id = $project_id' in driver.calls[2][0]


@pytest.mark.asyncio
async def test_human_confirmed_preference_outranks_agent_confirmed_same_key():
    driver = SequentialDriver([
        [
            preference_node(
                'agent-density',
                'agent-density',
                'Agent density',
                'Use compact density.',
                preference_key='ui-density',
                confirmation_status='agent_confirmed',
            ),
            preference_node(
                'human-density',
                'human-density',
                'Human density',
                'Use comfortable density.',
                preference_key='ui-density',
            ),
        ],
        [],
    ])
    store = StoreStub(driver)

    result = await read_collaboration_context(
        store,
        {'id': 'principal-1'},
        'personal-space',
    )

    assert {item.id for item in result.global_preferences} == {
        'agent-density',
        'human-density',
    }
    assert [item.id for item in result.effective_preferences] == ['human-density']
    assert result.conflicts == []


class StoreStub:
    def __init__(self, driver):
        self.runtime = SimpleNamespace(driver=driver)
        self.settings = SimpleNamespace(provider_mode='personal', graph_limit=500)

    async def authorize(self, actor, space_id, role):
        assert actor['id'] == 'principal-1'
        assert space_id == 'personal-space'
        assert role == 'reader'
        return {
            'id': 'personal-space',
            'kind': 'personal',
            'group_id': 'personal-group',
        }


class SequentialDriver:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return self.responses.pop(0), None, None


def preference_node(
    item_id,
    key,
    title,
    instruction,
    *,
    scope='global',
    project_id=None,
    preference_key=None,
    confirmation_status='confirmed',
):
    attributes = {'preferenceKey': preference_key} if preference_key else {}
    return {
        'id': item_id,
        'key': key,
        'title': title,
        'instruction': instruction,
        'profile_aspect': 'taste',
        'preference_scope': scope,
        'preference_project_id': project_id,
        'attributes_json': json.dumps(attributes),
        'confirmation_basis_json': confirmation_basis(confirmation_status),
        'confirmation_status': confirmation_status,
        'created_at': datetime(2026, 7, 28, 8, 0, tzinfo=UTC),
    }


def confirmation_basis(status='confirmed'):
    agent_confirmed = status == 'agent_confirmed'
    return json.dumps({
        'existence_reason': '用户明确表达了这条偏好。',
        'quadrant_reason': '偏好由用户直接表达。',
        'proposed_by': {'kind': 'user', 'label': '用户'},
        'confirmed_by': (
            {'kind': 'agent', 'label': 'Fuli usage policy'}
            if agent_confirmed else {'kind': 'user', 'label': '用户'}
        ),
        'confirmed_at': '2026-07-28T08:00:00Z',
        **(
            {'agent_policy_version': 'agent-usage-v1'}
            if agent_confirmed else {}
        ),
    })
