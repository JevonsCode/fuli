import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from fuli_graph.knowledge_search import (
    _dedupe_ranked_edges,
    _dedupe_ranked_entities,
    _edge_relevance,
    _entity_search_result,
    _item_scope_metadata,
    _ranked_records,
    _ranked_relevance,
    _relevance,
    _term_weights,
    personal_edge_scopes,
    personal_project_scopes,
    search_knowledge,
)
from fuli_graph.models import SearchRequest


@pytest.mark.asyncio
async def test_personal_edge_scope_uses_assignments_references_and_global_episodes():
    driver = RecordingDriver([
        {'id': 'edge-a', 'assignment_project_id': 'project-a'},
        {'id': 'edge-global', 'has_global_episode': True},
    ])
    store = SimpleNamespace(runtime=SimpleNamespace(driver=driver))

    project_ids = ['project-a', 'project-b']
    result = set(await personal_edge_scopes(
        store,
        {'id': 'personal-space', 'group_id': 'personal-group'},
        SearchRequest(
            space_ids=['personal-space'],
            query='scope',
            personal_project_ids=project_ids,
            include_personal_global=True,
        ),
        {
            project_id: {'scope_distance': 0, 'scope_path': [project_id], 'inherited': False}
            for project_id in project_ids
        },
        True,
        ['edge-a', 'edge-b', 'edge-global'],
    ))

    query, parameters = driver.calls[0]
    assert result == {'edge-a', 'edge-global'}
    assert 'FuliKnowledgeAssignment' in query
    assert 'FuliKnowledgeProjectReference' in query
    assert 'project_id IS NULL' in query
    assert parameters['project_ids'] == ['project-a', 'project-b']
    assert parameters['include_personal_global'] is True


@pytest.mark.asyncio
async def test_project_inheritance_traverses_only_two_explicit_directional_hops():
    driver = RecordingDriver([
        {
            'project_id': 'parent-project',
            'scope_path': ['child-project', 'parent-project'],
            'scope_distance': 1,
        },
        {
            'project_id': 'cycle-project',
            'scope_path': ['child-project', 'parent-project', 'child-project'],
            'scope_distance': 2,
        },
    ])
    store = SimpleNamespace(runtime=SimpleNamespace(driver=driver))
    request = SearchRequest(
        space_ids=['personal-space'],
        query='如何部署',
        personal_project_ids=['child-project'],
        active_personal_project_id='child-project',
    )

    scopes = await personal_project_scopes(
        store,
        {'id': 'personal-space', 'group_id': 'personal-group'},
        request,
    )

    query, parameters = driver.calls[0]
    assert scopes == {
        'child-project': {
            'scope_distance': 0,
            'scope_path': ['child-project'],
            'inherited': False,
        },
        'parent-project': {
            'scope_distance': 1,
            'scope_path': ['child-project', 'parent-project'],
            'inherited': True,
        },
    }
    assert 'PERSONAL_PROJECT_RELATION*1..2' in query
    assert "['PART_OF', 'USES_KNOWLEDGE_FROM']" in query
    assert parameters['active_project_id'] == 'child-project'


@pytest.mark.parametrize('origin', [
    {'assignment_project_id': 'other-project'},
    {'episode_project_ids': ['other-project']},
])
def test_old_global_episode_cannot_bypass_current_project_ownership(origin):
    request = SearchRequest(space_ids=['personal-space'], query='deployment',
                            personal_project_ids=['active-project'])
    scopes = {'active-project': {'scope_distance': 0, 'scope_path': ['active-project'], 'inherited': False}}
    record = {'profile_aspect': None, 'has_global_episode': True, **origin}
    assert _item_scope_metadata(record, request, scopes, True) is None


def test_scope_missing_records_fail_closed_but_real_global_knowledge_stays_available():
    request = SearchRequest(space_ids=['personal-space'], query='deployment',
                            personal_project_ids=['active-project'])
    assert _item_scope_metadata({'id': 'old-record'}, request, {}, True) is None
    assert _item_scope_metadata({'id': 'old-record'}, request, {}, False) is None
    assert _item_scope_metadata({'has_global_episode': True}, request, {}, True) == {
        'defined_project_id': None, 'scope_distance': 0,
        'inherited_from_project_id': None, 'scope_path': [], 'inherited': False,
    }


def test_project_references_share_knowledge_without_changing_its_primary_scope():
    request = SearchRequest(space_ids=['personal-space'], query='scope',
                            personal_project_ids=['active-project'])
    scopes = {'active-project': {
        'scope_distance': 0, 'scope_path': ['active-project'], 'inherited': False,
    }}
    # A reference does not move the primary owner. Genuine global knowledge
    # remains global even when another project references it.
    global_reference = {
        'has_global_episode': True, 'reference_project_ids': ['other-project'],
    }
    assert _item_scope_metadata(global_reference, request, scopes, True)['defined_project_id'] is None
    assert _item_scope_metadata(global_reference, request, scopes, False) is None
    owned = {**global_reference, 'assignment_project_id': 'owner-project'}
    assert _item_scope_metadata(owned, request, scopes, True) is None
    shared = {**owned, 'reference_project_ids': ['active-project']}
    assert _item_scope_metadata(shared, request, scopes, False)['defined_project_id'] == 'active-project'


@pytest.mark.parametrize('active, expected', [('project-a', 'project-a'), ('project-b', 'project-b'),
                                               ('unrelated-project', None)])
def test_multi_project_preference_search_applies_in_each_explicit_project(active, expected):
    record = {'profile_aspect': 'taste', 'preference_scope': 'project',
              'preference_project_id': 'project-a', 'preference_project_ids': ['project-a', 'project-b']}
    request = SearchRequest(space_ids=['personal-space'], query='buttons',
                            personal_project_ids=[active], active_personal_project_id=active)
    scopes = {active: {'scope_distance': 0, 'scope_path': [active], 'inherited': False}}
    actual = _item_scope_metadata(record, request, scopes, True)
    assert (actual or {}).get('defined_project_id') == expected


def test_multi_project_preference_uses_active_project_and_never_widens_agent_scope():
    record = {'profile_aspect': 'taste', 'preference_scope': 'project',
              'preference_project_id': 'project-a', 'preference_project_ids': ['project-a', 'project-b']}
    request = SearchRequest(space_ids=['personal-space'], query='buttons', personal_project_ids=['project-a', 'project-b'],
                            active_personal_project_id='project-b', project_agent_id='agent-a')
    scopes = {pid: {'scope_distance': 0, 'scope_path': [pid], 'inherited': False} for pid in request.personal_project_ids}
    assert _item_scope_metadata(record, request, scopes, False)['defined_project_id'] == 'project-b'
    assert _item_scope_metadata({**record, 'preference_scope': 'agent', 'preference_agent_id': 'agent-a'},
                                request, scopes, False) is None
    legacy = {key: value for key, value in record.items() if key != 'preference_project_ids'}
    assert _item_scope_metadata(legacy, request, scopes, False)['defined_project_id'] == 'project-a'


def test_item_level_inheritance_is_opt_in_and_never_applies_to_preferences():
    request = SearchRequest(
        space_ids=['personal-space'],
        query='如何部署',
        personal_project_ids=['child-project'],
        active_personal_project_id='child-project',
    )
    scopes = {
        'child-project': {
            'scope_distance': 0,
            'scope_path': ['child-project'],
            'inherited': False,
        },
        'parent-project': {
            'scope_distance': 1,
            'scope_path': ['child-project', 'parent-project'],
            'inherited': True,
        },
    }
    parent_item = {
        'profile_aspect': None,
        'assignment_project_id': 'parent-project',
        'episode_project_ids': [],
        'reference_project_ids': [],
        'has_global_episode': False,
        'inheritance_mode': 'descendants',
        'inherited_project_ids': [],
    }

    inherited = _item_scope_metadata(parent_item, request, scopes, True)

    assert inherited == {
        'defined_project_id': 'parent-project',
        'scope_distance': 1,
        'inherited_from_project_id': 'parent-project',
        'scope_path': ['child-project', 'parent-project'],
        'inherited': True,
    }
    assert _item_scope_metadata(
        {**parent_item, 'inheritance_mode': 'local_only'},
        request,
        scopes,
        True,
    ) is None
    assert _item_scope_metadata(
        {
            **parent_item,
            'profile_aspect': 'taste',
            'preference_scope': 'project',
            'preference_project_id': 'parent-project',
        },
        request,
        scopes,
        True,
    ) is None


def test_exact_active_project_key_overrides_a_higher_scoring_inherited_item():
    inherited = {
        'id': 'parent-item',
        'key': 'deployment.runbook',
        'defined_project_id': 'parent-project',
        'inherited_from_project_id': 'parent-project',
        'scope_distance': 1,
        'created_at': datetime(2026, 7, 29, tzinfo=timezone.utc),
    }
    local = {
        'id': 'child-item',
        'key': 'deployment.runbook',
        'defined_project_id': 'child-project',
        'inherited_from_project_id': None,
        'scope_distance': 0,
        'created_at': datetime(2026, 7, 28, tzinfo=timezone.utc),
    }

    ranked = _dedupe_ranked_entities(
        [(inherited, 12.0), (local, 2.0)],
        'child-project',
    )

    assert ranked == [(local, 2.0)]


def test_project_agent_memory_is_visible_only_to_its_selected_agent():
    scopes = {
        'project-a': {
            'scope_distance': 0,
            'scope_path': ['project-a'],
            'inherited': False,
        },
    }
    agent_item = {
        'profile_aspect': None,
        'assignment_project_id': None,
        'episode_project_ids': ['project-a'],
        'episode_project_agent_ids': ['agent-a'],
        'reference_project_ids': [],
        'has_global_episode': False,
        'inheritance_mode': 'local_only',
        'inherited_project_ids': [],
    }
    default_request = SearchRequest(
        space_ids=['personal-space'],
        query='活动复盘',
        personal_project_ids=['project-a'],
        active_personal_project_id='project-a',
    )
    agent_a_request = default_request.model_copy(
        update={'project_agent_id': 'agent-a'}
    )
    agent_b_request = default_request.model_copy(
        update={'project_agent_id': 'agent-b'}
    )

    assert _item_scope_metadata(agent_item, default_request, scopes, True) is None
    assert _item_scope_metadata(agent_item, agent_b_request, scopes, True) is None
    assert _item_scope_metadata(agent_item, agent_a_request, scopes, True) == {
        'defined_project_id': 'project-a',
        'scope_distance': 0,
        'inherited_from_project_id': None,
        'scope_path': ['project-a'],
        'inherited': False,
        'project_agent_id': 'agent-a',
    }


def test_selected_agent_item_overrides_same_key_project_item():
    project_item = {
        'id': 'project-item',
        'key': 'activity.format',
        'defined_project_id': 'project-a',
        'scope_distance': 0,
        'created_at': datetime(2026, 8, 17, tzinfo=timezone.utc),
    }
    agent_item = {
        **project_item,
        'id': 'agent-item',
        'project_agent_id': 'agent-a',
        'created_at': datetime(2026, 8, 16, tzinfo=timezone.utc),
    }

    ranked = _dedupe_ranked_entities(
        [(project_item, 12.0), (agent_item, 2.0)],
        'project-a',
        'agent-a',
    )

    assert ranked == [(agent_item, 2.0)]


def test_confirmation_authority_affects_ranking_but_not_quadrants():
    def basis(status, actor):
        value = {'existence_reason': 'Synthetic.', 'quadrant_reason': 'Synthetic.',
                 'proposed_by': {'kind': 'agent'}}
        if actor:
            value.update(confirmed_by={'kind': actor}, confirmed_at='2026-10-18T00:00:00Z')
        if status == 'agent_confirmed':
            value['agent_policy_version'] = 'agent-usage-v1'
        return {'confirmation_status': status, 'confirmation_basis_json': json.dumps(value)}

    confirmed = _ranked_relevance(10, {
        **basis('confirmed', 'user'),
        'origin_quadrant': 'unknown_unknown',
    })
    agent_confirmed = _ranked_relevance(10, {
        **basis('agent_confirmed', 'agent'),
        'origin_quadrant': 'known_known',
    })
    pending = _ranked_relevance(10, {
        **basis('pending', None),
        'origin_quadrant': 'known_known',
    })

    assert confirmed > agent_confirmed > pending


def test_entity_relevance_keeps_personal_profile_bounded_and_task_related():
    matching = _relevance('按钮设计', {
        'name': '统一按钮与交互控件',
        'type': 'DesignTaste',
        'summary': '不同性质的按钮不要混放。',
        'reasoning_summary': None,
        'profile_aspect': 'taste',
    })
    unrelated = _relevance('按钮设计', {
        'name': '日志排查方式',
        'type': 'Runbook',
        'summary': '先查询线上错误日志。',
        'reasoning_summary': None,
        'profile_aspect': None,
    })

    assert matching > 0
    assert unrelated == 0


def test_relevance_rejects_generic_overlap_in_a_specific_fact_lookup():
    query = '“千人来华”页面的线上地址是什么？'
    relevant = _relevance(query, {
        'name': '千人来华页面',
        'type': 'Deployment',
        'summary': '千人来华页面的线上地址是 https://example.test/visit-china。',
        'reasoning_summary': None,
        'profile_aspect': None,
    })
    generic = _relevance(query, {
        'name': '工作区模式状态收进页面标题',
        'type': 'ProductRequirement',
        'summary': '页面标题旁显示本地与公共服务的连接边界。',
        'reasoning_summary': None,
        'profile_aspect': None,
    })

    assert relevant > 0
    assert generic == 0


def test_relevance_uses_explicit_search_terms_for_long_conversational_requests():
    query = '检查一下代码，有问题暂停和我讨论，没问题发布一个新版本 0.7.0'
    runbook = _relevance(query, {
        'name': 'FULI GitHub Connector 提交 Runbook',
        'type': 'Runbook',
        'summary': '使用已连接的 GitHub Connector 提交。',
        'reasoning_summary': None,
        'profile_aspect': None,
        'attributes_json': '{"searchTerms":["发布新版本","推送 GitHub"]}',
    })
    unrelated = _relevance(query, {
        'name': '日志排查方式',
        'type': 'Runbook',
        'summary': '先查询线上错误日志。',
        'reasoning_summary': None,
        'profile_aspect': None,
        'attributes_json': '{"searchTerms":["日志错误"]}',
    })

    assert runbook > 0
    assert unrelated == 0


PREFERENCE = {
    'name': 'Answer in Chinese',
    'type': 'PersonalPreference',
    'summary': 'Use Simplified Chinese unless the user writes otherwise.',
    'reasoning_summary': None,
    'profile_aspect': 'taste',
    'key': 'pref-1',
    'attributes_json': '{"preferenceKey":"reply-language"}',
}


@pytest.mark.parametrize('query', ['reply-language', 'reply language', 'Which reply language?'])
def test_a_preference_is_found_by_its_key_as_written_and_as_words(query):
    # rec#75: none of these words is in its name or summary.
    assert _relevance(query, PREFERENCE) > 0


def test_a_preference_without_a_stated_key_is_found_by_its_capture_key():
    record = {**PREFERENCE, 'key': 'reply_language', 'attributes_json': '{}'}

    assert _relevance('reply_language', record) > 0
    assert _relevance('reply language', record) > 0


def test_only_a_preference_is_found_by_its_key():
    fact = {**PREFERENCE, 'profile_aspect': None, 'type': 'ProjectFact'}

    assert _relevance('reply-language', fact) == 0


def test_relevance_keeps_spaced_chinese_query_terms_separate():
    score = _relevance(
        '推送 提交 push commit GitHub Connector runbook',
        {
            'name': 'FULI GitHub Connector 提交 Runbook',
            'type': 'Runbook',
            'summary': '通过 GitHub Connector 推送提交。',
            'reasoning_summary': None,
            'profile_aspect': None,
        },
    )

    assert score > 0


def test_entity_search_projection_normalizes_temporal_fields_once():
    changed_at = datetime(2026, 7, 23, 10, 30, tzinfo=timezone.utc)
    record = {
        'id': 'entity-1',
        'group_id': 'personal-group',
        'name': '回归测试策略',
        'type': 'EngineeringDecision',
        'summary': '核心检索必须覆盖实体结果投影。',
        'key': 'alignment:network:preference:c',
        'attributes_json': json.dumps({
            'preferenceKey': 'alignment.comments.explain-function',
        }),
        'created_at': changed_at,
        'human_edited': True,
        'human_change_status': 'viewed',
        'human_change_version': 2,
        'last_human_changed_at': changed_at,
        'last_agent_viewed_at': changed_at,
        'last_agent_reviewed_at': None,
        'confirmation_basis_json': None,
        'source_references': [{
            'uri': 'https://docs.example.invalid/project/test-strategy',
            'reference_time': changed_at,
        }],
    }

    result = _entity_search_result(record, 0.75, 'personal-space')

    assert result.id == 'entity-1'
    assert result.space_id == 'personal-space'
    assert result.created_at == changed_at
    assert result.last_human_changed_at == changed_at
    assert result.last_agent_viewed_at == changed_at
    assert result.last_agent_reviewed_at is None
    assert result.source_uris == [
        'https://docs.example.invalid/project/test-strategy'
    ]
    assert result.key == 'alignment:network:preference:c'
    assert result.preference_key == 'alignment.comments.explain-function'
    assert 'attributes' not in result.model_dump()
    assert result.score == 0.75


def test_edge_relevance_promotes_literal_match_without_losing_semantic_order():
    unrelated = SimpleNamespace(
        name='GOVERNS', fact='项目使用本地运行时。',
        source_node_uuid='source-a', target_node_uuid='target-a',
    )
    matching = SimpleNamespace(
        name='PREFERS', fact='界面按钮需要保持统一。',
        source_node_uuid='source-b', target_node_uuid='target-b',
    )

    first_score = _edge_relevance('界面按钮', unrelated, {}, 0, 20)
    later_score = _edge_relevance('界面按钮', matching, {}, 19, 20)

    assert first_score == 0
    assert later_score > first_score


@pytest.mark.asyncio
async def test_search_drops_graphiti_candidates_without_minimum_textual_evidence():
    edge = SimpleNamespace(
        uuid='edge-unrelated',
        group_id='project-group',
        name='REQUIRES',
        fact='四象限模型保留来源状态、当前状态与迁移依据。',
        source_node_uuid='source-unrelated',
        target_node_uuid='target-unrelated',
        valid_at=None,
        invalid_at=None,
        created_at=datetime(2026, 7, 23, tzinfo=timezone.utc),
        episodes=[],
    )
    store = SearchStore(edge)
    result = await search_knowledge(
        store,
        {'id': 'actor'},
        SearchRequest(
            space_ids=['project-space'],
            query='千人来华',
            limit=5,
        ),
    )

    assert result.facts == []


class RecordingDriver:
    def __init__(self, records):
        self.records = records
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return self.records, None, None


class SearchStore:
    def __init__(self, edge):
        self.runtime = SimpleNamespace(
            graphiti=GraphitiSearch(edge),
            driver=SearchDriver(),
        )

    async def authorize(self, actor, space_id, role):
        del actor, role
        return {'id': space_id, 'kind': 'project', 'group_id': 'project-group'}


class GraphitiSearch:
    def __init__(self, edge):
        self.edge = edge

    async def search(self, query, *, group_ids, num_results):
        del query, group_ids, num_results
        return [self.edge]


class SearchDriver:
    async def execute_query(self, query, **parameters):
        del parameters
        if 'MATCH (n:Entity)' in query:
            return [
                {'uuid': 'source-unrelated', 'name': '四象限认识论内核'},
                {'uuid': 'target-unrelated', 'name': '象限迁移历史'},
            ], None, None
        return [], None, None


def test_a_historical_and_a_current_entity_sharing_one_key_both_survive_dedupe():
    historical = {
        'id': 'old-entity',
        'key': 'aurora.deployment',
        'invalid_at': datetime(2026, 10, 20, tzinfo=timezone.utc),
    }
    current = {'id': 'current-entity', 'key': 'aurora.deployment', 'invalid_at': None}

    survived = _dedupe_ranked_entities(
        [(historical, 12.0), (current, 4.0)],
        'aurora-project',
    )

    assert {record['id'] for record, _ in survived} == {'old-entity', 'current-entity'}


def test_two_current_entities_sharing_one_key_collapse_to_one():
    first = {'id': 'entity-a', 'key': 'aurora.deployment', 'invalid_at': None}
    second = {'id': 'entity-b', 'key': 'aurora.deployment', 'invalid_at': None}

    survived = _dedupe_ranked_entities(
        [(first, 8.0), (second, 2.0)],
        'aurora-project',
    )

    assert [record['id'] for record, _ in survived] == ['entity-a']


def test_a_historical_and_a_current_edge_sharing_one_key_both_survive_dedupe():
    historical = SimpleNamespace(
        uuid='old-edge', invalid_at=datetime(2026, 10, 20, tzinfo=timezone.utc),
    )
    current = SimpleNamespace(uuid='current-edge', invalid_at=None)
    metadata = {'old-edge': {'key': 'aurora.port'}, 'current-edge': {'key': 'aurora.port'}}

    survived = _dedupe_ranked_edges(
        [(12.0, historical), (4.0, current)],
        metadata,
        'aurora-project',
    )

    assert {edge.uuid for _, edge in survived} == {'old-edge', 'current-edge'}


def test_two_current_edges_sharing_one_key_collapse_to_one():
    first = SimpleNamespace(uuid='edge-a', invalid_at=None)
    second = SimpleNamespace(uuid='edge-b', invalid_at=None)
    metadata = {'edge-a': {'key': 'aurora.port'}, 'edge-b': {'key': 'aurora.port'}}

    survived = _dedupe_ranked_edges(
        [(8.0, first), (2.0, second)],
        metadata,
        'aurora-project',
    )

    assert [edge.uuid for _, edge in survived] == ['edge-a']


def test_a_concept_matches_whatever_word_form_the_question_uses():
    # rec#63: "the team that owns the ledger code" never met "Ledger code owner".
    record = {'name': 'Orbit ledger code owner', 'type': 'ProjectKnowledge',
              'summary': 'The ledger code is owned by the ledger squad, who review every change there.'}
    assert _relevance('owns codes', record) > 0
    assert _relevance('who reviews changes', record) > 0
    assert _relevance('release freeze window', record) == 0


def _synthetic_project_records():
    """A project's records as one search sees them: the product's own words
    (控制台, 圆桌, FLA) run through many of them."""
    record = lambda name, summary, aspect=None: {
        'name': name, 'type': 'Knowledge', 'summary': summary, 'reasoning_summary': None, 'profile_aspect': aspect}
    return [
        record('AI 替人操作', 'AI 要能替人操作所有事情，不要让人总去控制台里做。', 'judgment_preference'),
        record('介绍团队', '介绍团队时讲清每个项目一位负责人 FLA，宣传要包含圆桌。', 'judgment_preference'),
        record('控制台布局', '控制台页面用整宽，不做左右分栏。', 'taste'),
        record('控制台文案', '控制台里给人看的字不超过一百个。', 'taste'),
        record('FLA 起名', '每个 FLA 有自己的名字。'),
        record('FLA 头像', '介绍 FLA 时带上头像。'),
        record('FLA 分工', '复杂的事由负责人做，FLA 接有边界的部分。'),
        record('圆桌演示', '圆桌的演示对话至少三四个来回。', 'taste'),
        record('统一按钮与交互控件', '不同性质的按钮不要混放。', 'taste'),
        record('发布说明', '发布说明写短一点。', 'taste'),
        record('会话卡片', '不要让人去点会话卡片。', 'judgment_preference'),
        record('日志排查方式', '先查询线上错误日志。'),
    ]


def test_sharing_only_the_projects_common_words_with_a_query_is_not_a_match():
    records = _synthetic_project_records()
    by_name = {record['name']: record for record in records}

    def found(query, extra=()):
        candidates = [*records, *extra]
        weights = _term_weights(query, candidates)
        scored = [(record['name'], _relevance(query, record, weights)) for record in candidates]
        return [name for name, score in sorted(scored, key=lambda item: -item[1]) if score > 0]

    # Nothing here says which port: three records only share 控制台 with the question.
    assert found('控制台端口') == []
    port = {**by_name['日志排查方式'], 'name': '控制台端口', 'summary': '本机控制台端口是 2828。'}
    assert found('控制台端口', [port])[0] == '控制台端口'
    # 圆桌 and FLA alone do not answer how an FLA is woken.
    assert found('圆桌 叫醒 FLA') == []
    wake = {**by_name['日志排查方式'], 'name': '叫醒 FLA', 'summary': '圆桌叫醒 FLA 先续接它上次的会话。'}
    assert found('圆桌 叫醒 FLA', [wake]) == ['叫醒 FLA']
    # Two words written together still find the record that carries one of them:
    # the characters that only meet across the boundary (钮设) count for less.
    assert found('按钮设计') == ['统一按钮与交互控件']
    # A query whose words nobody wrote down matches nothing, whatever common word it shares.
    assert found('更新本机 FLA 安装') == []


def test_term_weights_follow_how_few_candidates_carry_a_term():
    records = _synthetic_project_records()
    weights = _term_weights('圆桌 叫醒 FLA 按钮', records)
    assert weights['按钮'] > weights['圆桌'] > weights['fla']
    assert weights['叫醒'] < weights['按钮'], 'a term nobody carries counts for less than the rarest real one'
    assert _term_weights('圆桌', records[:7]) == {} and _term_weights('', records) == {}, 'too few candidates to weigh'
    # Without weights every term counts the same, as before.
    assert _relevance('按钮设计', records[8]) > 0


def test_a_linking_particle_does_not_break_a_phrase():
    """rec#111: the fact said 控制台的端口; the question asked 控制台端口."""
    fact = {'name': '本机控制台端口', 'type': 'ProjectFact', 'summary': '这台机器上本机控制台的端口是 2828。',
            'reasoning_summary': None, 'profile_aspect': None}
    named = {**fact, 'name': '端口说明'}
    preference = {'name': 'AI 替人操作', 'type': 'PersonalPreference', 'summary': '不要让人总去控制台里做。',
                  'reasoning_summary': None, 'profile_aspect': 'judgment_preference'}
    assert _relevance('控制台端口', named) >= 8.0, 'the whole phrase, with 的 between its words'
    assert _relevance('控制台端口', named) > 3 * _relevance('控制台端口', preference)
    assert _relevance('圆桌之外', {**fact, 'name': 'x', 'summary': '圆桌外的事'}) >= 8.0, '之 links the same way'
    assert _relevance('的端口', {**fact, 'name': 'x', 'summary': '端口'}) < 8.0, 'a leading 的 is not between two characters'
    # The same on both sides: a word that contains 的 still matches itself.
    assert _relevance('目的', {**fact, 'name': '目的', 'summary': '这个项目的目的是省事。'}) >= 8.0
    assert _relevance('reply language', {**fact, 'name': 'x', 'summary': 'the reply language of this project'}) >= 8.0


def test_at_the_same_score_and_weight_the_closer_match_comes_first():
    """Three of the question's words beat one, though both round to the same band and the weaker is newer."""
    confirmed = {'confirmation_status': 'confirmed', 'origin_quadrant': 'known_known', 'scope_distance': 0,
                 'confirmation_basis_json': json.dumps({
                     'existence_reason': 'Synthetic.', 'quadrant_reason': 'Synthetic.', 'proposed_by': {'kind': 'agent'},
                     'confirmed_by': {'kind': 'user'}, 'confirmed_at': '2026-10-18T00:00:00Z'})}
    closer = {**confirmed, 'id': 'closer', 'created_at': '2026-10-01T00:00:00Z'}
    weaker = {**confirmed, 'id': 'weaker', 'created_at': '2026-11-01T00:00:00Z'}
    pending = {'confirmation_status': 'pending', 'origin_quadrant': 'known_known', 'scope_distance': 0, 'id': 'pending',
               'created_at': '2026-11-02T00:00:00Z'}
    ranked = _ranked_records([(weaker, 1.58), (pending, 1.9), (closer, 1.8), ({**confirmed, 'id': 'none'}, 0.0)])
    assert [record['id'] for record, _ in ranked] == ['closer', 'weaker', 'pending']
    assert ranked[0][1] == ranked[1][1] > ranked[2][1], 'closeness only orders a tie; the weight still decides inside a band'

