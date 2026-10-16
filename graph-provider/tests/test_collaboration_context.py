import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from fuli_graph.collaboration_context import read_collaboration_context


@pytest.mark.asyncio
async def test_owned_complete_source_resolves_conflict_beyond_the_public_200_window():
    rows = [preference_node(f'global-{i}', f'global-{i}', 'Global', f'Rule {i}') for i in range(199)]
    rows += [preference_node(f'project-{i}', f'project-{i}', 'Risk', instruction,
                            scope='project', project_id='project-a', preference_key='risk')
             for i, instruction in enumerate(['Prefer speed.', 'Prefer caution.'])]
    def driver():
        return SequentialDriver([[{'project': {'project_id': 'project-a'}}], [], rows, [], []])
    public = await read_collaboration_context(StoreStub(driver()), {'id': 'principal-1'},
                                              'personal-space', 'project-a', limit=200)
    assert public.truncated and not public.conflicts
    owned_driver = driver()
    complete = await read_collaboration_context(StoreStub(owned_driver), {'id': 'principal-1'},
                                                'personal-space', 'project-a', complete=True)
    assert not complete.truncated
    assert len(complete.effective_preferences) == 199
    assert len(complete.conflicts) == 1
    assert set(complete.conflicts[0].item_ids) == {'project-0', 'project-1'}
    assert owned_driver.calls[2][1]['limit'] == 501


@pytest.mark.asyncio
async def test_owned_complete_source_keeps_candidate_and_related_queue_caps_explicit():
    rows = [preference_node(str(i), str(i), 'Rule', f'Rule {i}') for i in range(3)]
    store = StoreStub(SequentialDriver([rows, []]))
    store.settings.graph_limit = 2
    result = await read_collaboration_context(store, {'id': 'principal-1'}, 'personal-space', complete=True)
    assert result.source_windows.candidates_truncated is True
    assert result.truncated is True
    assert store.runtime.driver.calls[0][1]['limit'] == 3


@pytest.mark.asyncio
@pytest.mark.parametrize('cap,extra', [(2, 0), (2, 1), (64, 0), (64, 1)])
async def test_ancestor_window_marks_overflow_without_consuming_the_sentinel(cap, extra):
    ancestors = [{'project_id': f'parent-{i:03}', 'scope_distance': 1,
                  'scope_path': ['project-a', f'parent-{i:03}']} for i in range(cap + extra)]
    driver = SequentialDriver([[{'project': {'project_id': 'project-a'}}], ancestors, [], []])
    store = StoreStub(driver)
    store.settings.graph_limit = cap if cap < 64 else 500
    result = await read_collaboration_context(store, {'id': 'principal-1'}, 'personal-space', 'project-a')
    assert driver.calls[1][1]['inheritance_limit'] == cap + 1
    assert len(driver.calls[2][1]['inherited_project_ids']) == cap
    assert result.source_windows.project_ancestors_truncated is bool(extra)
    assert result.source_windows.candidates_truncated is False
    assert result.source_windows.queued_conflicts_truncated is False
    assert result.truncated is bool(extra)
    assert len(driver.calls) == 4, 'No active conflicts means no queue query.'


@pytest.mark.asyncio
async def test_collaboration_context_layers_exact_project_and_suppresses_conflicts():
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-a'}}],
        [],
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
    assert 'node.fuli_preference_project_id = $project_id' in driver.calls[2][0]
    assert 'edge.fuli_preference_project_id = $project_id' in driver.calls[3][0]


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


@pytest.mark.asyncio
async def test_selected_project_agent_preference_overrides_project_and_global_layers():
    driver = SequentialDriver([
        [{'project': {'project_id': 'project-a'}}],
        [{'project': {'project_id': 'project-a'}}],
        [{'agent': {'agent_id': 'agent-a', 'status': 'active'}}],
        [],
        [
            preference_node(
                'global-format',
                'global-format',
                '全局格式',
                '使用全局格式。',
                preference_key='delivery-format',
            ),
            preference_node(
                'project-format',
                'project-format',
                '项目格式',
                '使用项目格式。',
                scope='project',
                project_id='project-a',
                preference_key='delivery-format',
            ),
            preference_node(
                'agent-format',
                'agent-format',
                'Agent 格式',
                '使用该 Agent 的活动复盘格式。',
                scope='agent',
                project_id='project-a',
                agent_id='agent-a',
                preference_key='delivery-format',
            ),
        ],
        [],
    ])
    store = StoreStub(driver)

    result = await read_collaboration_context(
        store,
        {'id': 'principal-1'},
        'personal-space',
        'project-a',
        100,
        'agent-a',
    )

    assert [item.id for item in result.agent_preferences] == ['agent-format']
    assert [item.id for item in result.effective_preferences] == ['agent-format']
    assert result.overridden_global_ids == ['global-format']
    assert result.overridden_project_ids == ['project-format']
    assert result.project_agent_id == 'agent-a'
    assert 'node.fuli_preference_agent_id = $project_agent_id' in driver.calls[4][0]
    assert driver.calls[4][1]['project_agent_id'] == 'agent-a'


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
        if 'active_groups' in parameters:
            return [], None, None
        return self.responses.pop(0), None, None


def preference_node(
    item_id,
    key,
    title,
    instruction,
    *,
    scope='global',
    project_id=None,
    agent_id=None,
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
        'preference_agent_id': agent_id,
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


@pytest.mark.asyncio
async def test_collaboration_context_preserves_structured_scope_qualifiers():
    node = preference_node('scoped-rule', 'scoped-rule', 'Scoped rule', 'Use only in the matching workflow.')
    node['attributes_json'] = json.dumps({
        'sessionId': 'synthetic-session', 'workflow': 'implementation',
        'custom_condition': {'unknown': 'retain'}, 'preferenceKey': 'scoped-rule', 'weight': 0.5,
    })
    result = await read_collaboration_context(
        StoreStub(SequentialDriver([[node], []])), {'id': 'principal-1'}, 'personal-space'
    )
    assert result.effective_preferences[0].preference_qualifiers == {
        'sessionId': 'synthetic-session', 'workflow': 'implementation',
        'custom_condition': {'unknown': 'retain'},
    }


@pytest.mark.asyncio
async def test_scope_filter_runs_before_override_and_retains_global_same_key():
    global_rule = preference_node('global', 'global', 'Global rule', 'Always apply globally.', preference_key='same-key')
    project_rule = preference_node('other-session', 'project', 'Session rule', 'Only for another session.',
                                   scope='project', project_id='project-a', preference_key='same-key')
    project_rule['attributes_json'] = json.dumps({'preferenceKey': 'same-key', 'sessionId': 'session-b'})
    store = StoreStub(SequentialDriver([
        [{'project': {'project_id': 'project-a'}}], [], [global_rule, project_rule], []
    ]))
    result = await read_collaboration_context(store, {'id': 'principal-1'}, 'personal-space', 'project-a',
                                            session_id='session-a')
    assert [item.id for item in result.effective_preferences] == ['global']
    assert result.overridden_global_ids == []
    assert result.task_scope_excluded_count == 1


@pytest.mark.asyncio
async def test_workflow_scope_requires_its_own_explicit_metadata_and_keeps_unknown_conditions():
    rows = [
        preference_node('business', 'business', 'Business workflow', 'Business rule'),
        preference_node('work-kind', 'work-kind', 'Work kind', 'Kind rule'),
        preference_node('unknown', 'unknown', 'Unknown condition', 'Keep unknown condition'),
    ]
    for row, attributes in zip(rows, [
        {'workflow': 'timesheet'}, {'workKind': 'review'}, {'workflow': {'custom': 'unknown'}},
    ]):
        row['attributes_json'] = json.dumps(attributes)
    result = await read_collaboration_context(
        StoreStub(SequentialDriver([rows, []])), {'id': 'principal-1'}, 'personal-space',
        work_kind='implementation'
    )
    assert {item.id for item in result.effective_preferences} == {'business', 'unknown'}
    result = await read_collaboration_context(
        StoreStub(SequentialDriver([rows, []])), {'id': 'principal-1'}, 'personal-space',
        work_kind='implementation', workflow='leave-request'
    )
    assert {item.id for item in result.effective_preferences} == {'unknown'}

@pytest.mark.asyncio
async def test_explicit_legacy_session_scope_is_filtered_before_same_key_override():
    session = '12345678-1234-1234-1234-123456789abc'
    global_rule = preference_node('global', 'global', 'Global', 'Always apply.', preference_key='same-key')
    scoped = preference_node('legacy', 'legacy', 'Legacy', f'仅在 Codex 会话 {session} 中适用；不扩大权限。',
                             scope='project', project_id='project-a', preference_key='same-key')
    for actual, expected in [('other-session', ['global']), (session, ['legacy']), (None, ['legacy'])]:
        result = await read_collaboration_context(
            StoreStub(SequentialDriver([[{'project': {'project_id': 'project-a'}}], [], [global_rule, scoped], []])),
            {'id': 'principal-1'}, 'personal-space', 'project-a', session_id=actual)
        assert [item.id for item in result.effective_preferences] == expected

@pytest.mark.asyncio
async def test_legacy_provenance_and_ambiguous_conditions_do_not_narrow_scope():
    session = '12345678-1234-1234-1234-123456789abc'
    rows = [preference_node('source', 'source', 'Source', 'General rule'),
            preference_node('ambiguous', 'ambiguous', 'Ambiguous', f'仅在 Codex 会话 {session} 或其他会话中适用。')]
    rows[0]['attributes_json'] = json.dumps({'sourceSessionId': session})
    result = await read_collaboration_context(StoreStub(SequentialDriver([rows, []])),
                                             {'id': 'principal-1'}, 'personal-space', session_id='other-session')
    assert {item.id for item in result.effective_preferences} == {'source', 'ambiguous'}
