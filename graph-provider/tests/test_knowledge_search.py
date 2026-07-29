from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from fuli_graph.knowledge_search import (
    _dedupe_ranked_entities,
    _edge_relevance,
    _entity_search_result,
    _item_scope_metadata,
    _ranked_relevance,
    _relevance,
    personal_edge_ids,
    personal_project_scopes,
    search_knowledge,
)
from fuli_graph.models import SearchRequest


@pytest.mark.asyncio
async def test_personal_edge_scope_uses_assignments_references_and_global_episodes():
    driver = RecordingDriver([{'id': 'edge-a'}, {'id': 'edge-global'}])
    store = SimpleNamespace(runtime=SimpleNamespace(driver=driver))

    result = await personal_edge_ids(
        store,
        {'id': 'personal-space', 'group_id': 'personal-group'},
        ['project-a', 'project-b'],
        True,
        ['edge-a', 'edge-b', 'edge-global'],
    )

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


def test_confirmation_authority_affects_ranking_but_not_quadrants():
    confirmed = _ranked_relevance(10, {
        'confirmation_status': 'confirmed',
        'confidence_score': 0.8,
        'utility_score': 0.5,
        'origin_quadrant': 'unknown_unknown',
    })
    agent_confirmed = _ranked_relevance(10, {
        'confirmation_status': 'agent_confirmed',
        'confidence_score': 0.8,
        'utility_score': 0.5,
        'origin_quadrant': 'known_known',
    })
    pending = _ranked_relevance(10, {
        'confirmation_status': 'pending',
        'confidence_score': 0.8,
        'utility_score': 0.5,
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


def test_entity_search_projection_normalizes_temporal_fields_once():
    changed_at = datetime(2026, 7, 23, 10, 30, tzinfo=timezone.utc)
    record = {
        'id': 'entity-1',
        'group_id': 'personal-group',
        'name': '回归测试策略',
        'type': 'EngineeringDecision',
        'summary': '核心检索必须覆盖实体结果投影。',
        'created_at': changed_at,
        'human_edited': True,
        'human_change_status': 'viewed',
        'human_change_version': 2,
        'last_human_changed_at': changed_at,
        'last_agent_viewed_at': changed_at,
        'last_agent_reviewed_at': None,
        'confirmation_basis_json': None,
    }

    result = _entity_search_result(record, 0.75, 'personal-space')

    assert result.id == 'entity-1'
    assert result.space_id == 'personal-space'
    assert result.created_at == changed_at
    assert result.last_human_changed_at == changed_at
    assert result.last_agent_viewed_at == changed_at
    assert result.last_agent_reviewed_at is None
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
