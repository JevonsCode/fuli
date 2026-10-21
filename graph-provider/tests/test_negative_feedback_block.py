"""A user's correction stays in force: rec issue 5, section 一 and scenario 1.

Every step goes through the production entry points. The in-memory graph keeps
item properties and audit nodes between calls and answers each production
query with only the aliases that query actually returns. It cannot prove the
Cypher; test_negative_feedback_block_neo4j.py runs the same story on Neo4j.
"""

import json
import re
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from fuli_graph.collaboration_context import read_collaboration_context
from fuli_graph.knowledge_audit import record_knowledge_feedback, record_knowledge_usage
from fuli_graph.knowledge_batch_confirmation import confirm_knowledge_batch
from fuli_graph.knowledge_feedback_models import KnowledgeFeedbackCreate
from fuli_graph.knowledge_management import revise_knowledge_item
from fuli_graph.knowledge_usage_models import KnowledgeUsageCreate
from fuli_graph.models import KnowledgeBatchConfirmationCreate, KnowledgeRevisionCreate
from fuli_graph.provider_values import stable_uuid
from sequential_driver_support import AsyncRows

ACTOR = {'id': 'principal-1'}
SPACE = 'personal-space'
OLD_STYLE = 'old-style'
CLIENT_STYLE = 'client-style'
RESTRAINED_STYLE = 'restrained-style'
TRACKED_STATE = (
    'fuli_confirmation_status', 'fuli_confirmation_basis_json',
    'fuli_utility_score', 'fuli_confidence_score', 'fuli_qualified_use_count',
    'fuli_distinct_task_count', 'fuli_last_used_at', 'fuli_negative_evidence_count',
    'fuli_requires_attention', 'fuli_negative_feedback_block_json',
)


@pytest.mark.asyncio
async def test_novelist_correction_survives_duplicate_and_new_use_and_keeps_client_rule():
    graph = MemoryGraph()
    graph.add_project('novel')
    graph.add_project('client-copy')
    graph.add_preference(OLD_STYLE, '写作风格：夸张排比', '写作时多用夸张排比。',
                         preference_key='writing-rhetoric')
    graph.add_preference(CLIENT_STYLE, '客户项目：标题风格', '客户项目的标题使用夸张排比。',
                         preference_key='writing-rhetoric', scope='project',
                         project_id='client-copy', status='confirmed')
    store = graph.store()

    # Given: five material uses across three tasks promoted the old preference.
    promoted = 0
    for task_id, use_kind in [('task-1', 'applied'), ('task-1', 'cited'), ('task-2', 'applied'),
                              ('task-2', 'cited'), ('task-3', 'applied')]:
        promoted += (await use(store, task_id, OLD_STYLE, use_kind)).promoted_count
    assert promoted == 1
    assert graph.items[OLD_STYLE]['fuli_confirmation_status'] == 'agent_confirmed'
    assert OLD_STYLE in await delivered(store, 'novel')
    client_before = graph.state(CLIENT_STYLE)

    # When: the user explicitly rejects it.
    feedback = await record_knowledge_feedback(store, ACTOR, KnowledgeFeedbackCreate(
        personal_space_id=SPACE, task_id='task-correction', session_id='novel-session',
        items=[{
            'item_id': OLD_STYLE, 'item_kind': 'entity', 'feedback_kind': 'contradicted',
            'reason': '之前那几篇是客户要求，不代表我喜欢。以后我自己的小说不要再用夸张排比，保持克制。',
            'evidence_summary': 'Synthetic fixture: the user corrected the inferred style.',
            'reported_by_kind': 'user',
        }],
    ))
    assert feedback.items[0].confirmation_status == 'pending'
    feedback_audit = graph.audit('knowledge_feedback', OLD_STYLE)
    block = json.loads(graph.items[OLD_STYLE]['fuli_negative_feedback_block_json'])
    assert block == {
        'audit_id': feedback_audit['id'],
        'feedback_kind': 'contradicted',
        'reported_by_kind': 'user',
        'blocked_at': feedback_audit['created_at'].isoformat(),
        'usage_generation': 1,
    }
    graph.add_preference(RESTRAINED_STYLE, '我自己的小说：保持克制', '我自己的小说不用夸张排比，保持克制。',
                         preference_key='novel-restraint', status='confirmed')
    ranking_at_block = {key: graph.items[OLD_STYLE][key]
                        for key in ['fuli_utility_score', 'fuli_confidence_score']}

    # And: the same usage event is replayed.
    before_duplicate = graph.state(OLD_STYLE)
    audits_before_duplicate = len(graph.audits)
    duplicate = await use(store, 'task-3', OLD_STYLE, 'applied')
    assert counts(duplicate) == (0, 1, 0)
    assert duplicate.items[0].confirmation_status == 'pending'
    assert graph.state(OLD_STYLE) == before_duplicate
    assert len(graph.audits) == audits_before_duplicate

    # And: new tasks keep using it, however many.
    for task_id in ['task-4', 'task-5', 'task-6', 'task-7', 'task-8']:
        result = await use(store, task_id, OLD_STYLE, 'applied')
        assert (result.recorded_count, result.promoted_count) == (1, 0)
    assert graph.items[OLD_STYLE]['fuli_confirmation_status'] == 'pending'
    assert graph.items[OLD_STYLE]['fuli_qualified_use_count'] == 10
    # Later use still counts for history, but cannot lift ranking past the rejection.
    for key, value in ranking_at_block.items():
        assert graph.items[OLD_STYLE][key] <= value, key
    assert json.loads(graph.items[OLD_STYLE]['fuli_negative_feedback_block_json']) == block

    # Then: another client writing the next chapter gets the correction, not the old rule.
    novel = await delivered(store, 'novel', session_id='another-client-session')
    assert OLD_STYLE not in novel
    assert RESTRAINED_STYLE in novel
    # And the client project's own style requirement is untouched and still delivered.
    assert graph.state(CLIENT_STYLE) == client_before
    assert await delivered(store, 'client-copy') == [CLIENT_STYLE, RESTRAINED_STYLE]


@pytest.mark.asyncio
async def test_duplicate_use_of_legacy_corrected_item_changes_nothing():
    """The issue's sample: demoted before this fix, so it has negatives but no block."""
    graph = MemoryGraph()
    graph.add_preference(OLD_STYLE, '写作风格：夸张排比', '写作时多用夸张排比。',
                         negative_evidence_count=1, requires_attention=True)
    for index, task_id in enumerate(['task-1', 'task-1', 'task-2', 'task-2', 'task-3']):
        graph.add_use(OLD_STYLE, task_id, ['applied', 'cited'][index % 2])
    graph.items[OLD_STYLE].update(fuli_qualified_use_count=5, fuli_distinct_task_count=3)
    store = graph.store()
    before = graph.state(OLD_STYLE)

    duplicate = await use(store, 'task-3', OLD_STYLE, 'applied')

    assert counts(duplicate) == (0, 1, 0)
    assert duplicate.items[0].qualified_use_count == 5
    assert graph.state(OLD_STYLE) == before

    fresh = await use(store, 'task-4', OLD_STYLE, 'cited')
    assert (fresh.recorded_count, fresh.promoted_count) == (1, 0)
    assert graph.items[OLD_STYLE]['fuli_confirmation_status'] == 'pending'


@pytest.mark.asyncio
async def test_agent_confirmed_item_with_counter_evidence_is_not_delivered():
    graph = MemoryGraph()
    graph.add_preference('agent-rule', 'Agent rule', 'Inferred from usage.',
                         status='agent_confirmed')
    graph.add_preference('human-rule', 'Human rule', 'Confirmed by the user.', status='confirmed',
                         negative_evidence_count=1, requires_attention=True)
    store = graph.store()
    assert await delivered(store) == ['agent-rule', 'human-rule']

    await record_knowledge_feedback(store, ACTOR, KnowledgeFeedbackCreate(
        personal_space_id=SPACE, task_id='task-validation',
        items=[{
            'item_id': 'agent-rule', 'item_kind': 'entity', 'feedback_kind': 'validation_failed',
            'reason': 'The inferred rule failed a local check.',
            'evidence_summary': 'Synthetic fixture: exit code 1.', 'reported_by_kind': 'agent',
        }],
    ))

    # An Agent report keeps the stored status and adds no durable block, but
    # usage-derived authority with counter-evidence no longer guides Agents.
    assert graph.items['agent-rule']['fuli_confirmation_status'] == 'agent_confirmed'
    assert graph.items['agent-rule'].get('fuli_negative_feedback_block_json') is None
    assert await delivered(store) == ['human-rule']


@pytest.mark.asyncio
async def test_explicit_human_confirmation_lifts_the_block_with_new_evidence_and_history():
    graph = MemoryGraph()
    graph.add_preference(OLD_STYLE, '写作风格：夸张排比', '写作时多用夸张排比。')
    store = graph.store()
    for task_id, use_kind in [('task-1', 'applied'), ('task-1', 'cited'), ('task-2', 'applied'),
                              ('task-2', 'cited'), ('task-3', 'applied')]:
        await use(store, task_id, OLD_STYLE, use_kind)
    await record_knowledge_feedback(store, ACTOR, KnowledgeFeedbackCreate(
        personal_space_id=SPACE, task_id='task-correction',
        items=[{
            'item_id': OLD_STYLE, 'item_kind': 'entity', 'feedback_kind': 'rejected',
            'reason': '用户否定了这条风格。', 'evidence_summary': 'Synthetic fixture.',
            'reported_by_kind': 'user',
        }],
    ))
    block = json.loads(graph.items[OLD_STYLE]['fuli_negative_feedback_block_json'])

    revision = await revise_knowledge_item(store, ACTOR, OLD_STYLE, KnowledgeRevisionCreate(
        personal_space_id=SPACE, item_kind='entity', action='confirm', operation_actor='human',
        reason='用户后来明确改回：这类作品仍然要用夸张排比。',
        confirmation_status='confirmed',
        confirmation_basis={
            'existence_reason': '用户明确恢复了这条风格。',
            'quadrant_reason': '用户直接表达。',
            'proposed_by': {'kind': 'agent', 'label': 'Codex'},
            'confirmed_by': {'kind': 'user', 'label': '当前用户'},
            'confirmed_at': datetime(2026, 10, 20, tzinfo=UTC),
        },
    ))

    item = graph.items[OLD_STYLE]
    assert item['fuli_confirmation_status'] == 'confirmed'
    assert item.get('fuli_negative_feedback_block_json') is None
    assert json.loads(item['fuli_confirmation_basis_json'])['confirmed_by']['kind'] == 'user'
    assert revision.previous['negativeFeedbackBlock'] == block
    assert revision.current['negativeFeedbackBlock'] is None
    assert [entry['action'] for entry in graph.revisions] == ['confirm']
    assert json.loads(graph.revisions[0]['previous_json'])['negativeFeedbackBlock'] == block
    # History is kept: the rejection and every use remain, and the confirmation is audited.
    assert graph.audit('knowledge_feedback', OLD_STYLE)['id'] == block['audit_id']
    assert graph.audit('human_change', OLD_STYLE)['operation'] == 'knowledge_confirm'
    assert len([a for a in graph.audits.values() if a['action'] == 'knowledge_used']) == 5
    assert await delivered(store) == [OLD_STYLE]


@pytest.mark.asyncio
@pytest.mark.parametrize('item_kind', ['entity', 'relationship'])
async def test_content_edit_that_raced_a_rejection_cannot_clear_the_block(item_kind):
    graph = MemoryGraph()
    graph.add_preference(OLD_STYLE, '写作风格：夸张排比', '写作时多用夸张排比。', item_kind=item_kind)
    embedder = EmbeddingPause()
    store = graph.store(embedder)
    assert await promote(store, OLD_STYLE, item_kind) == 1
    content = ({'name': '写作风格：排比'} if item_kind == 'entity'
               else {'fact': '写作时用排比。'})
    edit = KnowledgeRevisionCreate(personal_space_id=SPACE, item_kind=item_kind,
                                   action='update', operation_actor='human',
                                   reason='润色这条风格的措辞。', **content)

    # The edit reads the item, then the user's rejection commits while the
    # edit waits for its embedding.
    async def rejection_lands():
        await reject(store, OLD_STYLE, item_kind)
    embedder.during = rejection_lands
    with pytest.raises(HTTPException) as stale:
        await revise_knowledge_item(store, ACTOR, OLD_STYLE, edit)

    assert stale.value.status_code == 409
    rejected = graph.items[OLD_STYLE]
    block = json.loads(rejected['fuli_negative_feedback_block_json'])
    assert block['reported_by_kind'] == 'user'
    assert rejected['fuli_confirmation_status'] == 'pending'
    assert rejected['fuli_negative_evidence_count'] == 1
    assert graph.revisions == []
    assert not [a for a in graph.audits.values() if a['action'] == 'human_change']
    for task_id in ['task-4', 'task-5', 'task-6', 'task-7', 'task-8']:
        assert (await use(store, task_id, OLD_STYLE, 'applied', item_kind)).promoted_count == 0
    assert OLD_STYLE not in await delivered(store)
    # A retry writes a new version (rec#5 C7); what it carries of the block is
    # covered against Neo4j in test_knowledge_versions_neo4j.py.


CONFIRMATION_BASIS = {
    'existence_reason': '用户明确确认了这条风格。',
    'quadrant_reason': '用户直接表达。',
    'proposed_by': {'kind': 'agent', 'label': 'Codex'},
}


@pytest.mark.asyncio
@pytest.mark.parametrize('item_kind', ['entity', 'relationship'])
async def test_single_confirmation_read_before_a_rejection_is_refused(item_kind):
    graph = MemoryGraph()
    graph.add_preference(OLD_STYLE, '写作风格：夸张排比', '写作时多用夸张排比。', item_kind=item_kind)
    store = graph.store()
    graph.after_read = (OLD_STYLE, lambda: reject(store, OLD_STYLE, item_kind))
    confirm = KnowledgeRevisionCreate(
        personal_space_id=SPACE, item_kind=item_kind, action='confirm',
        operation_actor='human', reason='用户确认这条风格。', confirmation_status='confirmed',
        confirmation_basis={**CONFIRMATION_BASIS, 'confirmed_by': {'kind': 'user'},
                            'confirmed_at': datetime(2026, 10, 20, tzinfo=UTC)},
    )

    with pytest.raises(HTTPException) as stale:
        await revise_knowledge_item(store, ACTOR, OLD_STYLE, confirm)

    assert stale.value.status_code == 409
    block = json.loads(graph.items[OLD_STYLE]['fuli_negative_feedback_block_json'])
    assert graph.items[OLD_STYLE]['fuli_confirmation_status'] == 'pending'
    assert graph.revisions == []

    # Confirming again after reading the rejection lifts it, and history keeps it.
    revision = await revise_knowledge_item(store, ACTOR, OLD_STYLE, confirm)
    assert revision.previous['negativeFeedbackBlock'] == block
    assert json.loads(graph.revisions[0]['previous_json'])['negativeFeedbackBlock'] == block
    assert graph.items[OLD_STYLE]['fuli_negative_feedback_block_json'] is None
    assert graph.items[OLD_STYLE]['fuli_confirmation_status'] == 'confirmed'


@pytest.mark.asyncio
@pytest.mark.parametrize('rejected_kind', ['entity', 'relationship'])
async def test_batch_confirmation_read_before_a_rejection_is_refused_whole(rejected_kind):
    graph = MemoryGraph()
    items = {'entity': 'style-entity', 'relationship': 'style-relationship'}
    for kind, item_id in items.items():
        graph.add_preference(item_id, '写作风格：夸张排比', '写作时多用夸张排比。', item_kind=kind)
    store = graph.store()
    rejected = items[rejected_kind]
    graph.after_read = (rejected, lambda: reject(store, rejected, rejected_kind))
    request = KnowledgeBatchConfirmationCreate(
        personal_space_id=SPACE, group_kind='source', group_value='episode-1',
        reason='用户逐条确认了这次会话的风格。', operation_actor='human',
        confirmer={'kind': 'user', 'label': '当前用户'},
        items=[{'item_id': item_id, 'item_kind': kind, **CONFIRMATION_BASIS}
               for kind, item_id in items.items()],
    )

    with pytest.raises(HTTPException) as stale:
        await confirm_knowledge_batch(store, ACTOR, request)

    assert stale.value.status_code == 409
    assert f'{rejected_kind}:{rejected}' in stale.value.detail
    block = json.loads(graph.items[rejected]['fuli_negative_feedback_block_json'])
    # Nothing in the batch was confirmed and nothing was recorded.
    assert {graph.items[item_id]['fuli_confirmation_status'] for item_id in items.values()} == {
        'pending'}
    assert graph.revisions == []
    assert not [a for a in graph.audits.values() if a['action'] == 'human_change']

    # The retry reads the rejection; the explicit confirmation lifts it and keeps it.
    result = await confirm_knowledge_batch(store, ACTOR, request)
    assert result.confirmed_count == 2
    [revision] = [r for r in graph.revisions if r['item_id'] == rejected]
    assert json.loads(revision['previous_json'])['negativeFeedbackBlock'] == block
    assert json.loads(revision['current_json'])['negativeFeedbackBlock'] is None
    assert graph.items[rejected]['fuli_negative_feedback_block_json'] is None
    assert graph.items[rejected]['fuli_confirmation_status'] == 'confirmed'


async def use(store, task_id, item_id, use_kind, item_kind='entity'):
    return await record_knowledge_usage(store, ACTOR, KnowledgeUsageCreate(
        personal_space_id=SPACE, task_id=task_id, session_id=f'session-{task_id}',
        tool_name='record_knowledge_usage',
        items=[{'item_id': item_id, 'item_kind': item_kind, 'use_kind': use_kind}],
    ))


async def promote(store, item_id, item_kind='entity'):
    """Five material uses across three tasks: the agent confirmation threshold."""
    promoted = 0
    for task_id, use_kind in [('task-1', 'applied'), ('task-1', 'cited'), ('task-2', 'applied'),
                              ('task-2', 'cited'), ('task-3', 'applied')]:
        promoted += (await use(store, task_id, item_id, use_kind, item_kind)).promoted_count
    return promoted


async def reject(store, item_id, item_kind='entity', task_id='task-correction'):
    return await record_knowledge_feedback(store, ACTOR, KnowledgeFeedbackCreate(
        personal_space_id=SPACE, task_id=task_id,
        items=[{
            'item_id': item_id, 'item_kind': item_kind, 'feedback_kind': 'rejected',
            'reason': '用户否定了这条风格。', 'evidence_summary': 'Synthetic fixture.',
            'reported_by_kind': 'user',
        }],
    ))


def counts(result):
    return result.recorded_count, result.duplicate_count, result.promoted_count


async def delivered(store, project_id=None, **scope):
    result = await read_collaboration_context(store, ACTOR, SPACE, project_id, **scope)
    return sorted(item.id for item in result.effective_preferences)


class MemoryGraph:
    """Keeps graph state across calls; unknown production queries fail the test."""

    def __init__(self):
        self.items = {}
        self.audits = {}
        self.revisions = []
        self.projects = set()
        # (item_id, coroutine function): runs once, right after that item's
        # snapshot is read for a revision or confirmation.
        self.after_read = None

    def add_project(self, project_id):
        self.projects.add(project_id)

    def add_preference(self, item_id, name, summary, *, preference_key=None, scope='global',
                       project_id=None, status='pending', negative_evidence_count=0,
                       requires_attention=False, item_kind='entity'):
        # A relationship keeps its rule text as the fact; its name is the relation type.
        content = (
            {'kind': 'entity', 'name': name, 'summary': summary}
            if item_kind == 'entity' else
            {'kind': 'relationship', 'name': 'PREFERS', 'fact': summary,
             'source_name': name, 'target_name': 'Writing'}
        )
        self.items[item_id] = {
            'uuid': item_id, 'group_id': 'personal-group', **content,
            'created_at': datetime(2026, 10, 1, tzinfo=UTC),
            'fuli_profile_aspect': 'taste', 'fuli_preference_scope': scope,
            'fuli_preference_project_id': project_id,
            'fuli_attributes_json': json.dumps({'preferenceKey': preference_key or item_id}),
            'fuli_origin_quadrant': 'known_known', 'fuli_current_quadrant': 'known_known',
            'fuli_epistemic_status': 'confirmed' if status == 'confirmed' else 'observed',
            'fuli_confirmation_status': status,
            'fuli_confirmation_basis_json': json.dumps(basis(status), sort_keys=True),
            'fuli_usage_generation': 1, 'fuli_utility_score': 0.0,
            'fuli_confidence_score': 1.0 if status == 'confirmed' else 0.5,
            'fuli_qualified_use_count': 0, 'fuli_distinct_task_count': 0,
            'fuli_negative_evidence_count': negative_evidence_count,
            'fuli_requires_attention': requires_attention,
            'fuli_inheritance_mode': 'local_only', 'fuli_inherited_project_ids': [],
        }

    def add_use(self, item_id, task_id, use_kind):
        # The same event identity the usage writer derives, so a replay is a duplicate.
        audit_id = stable_uuid(SPACE, 'knowledge-usage', 'entity', item_id, '1', task_id, use_kind)
        self.audits[audit_id] = {
            'id': audit_id, 'space_id': SPACE, 'item_id': item_id, 'item_kind': 'entity',
            'action': 'knowledge_used', 'task_id': task_id, 'use_kind': use_kind,
            'usage_generation': 1, 'created_at': datetime(2026, 10, 2, tzinfo=UTC),
        }

    def state(self, item_id):
        return {key: self.items[item_id].get(key) for key in TRACKED_STATE}

    def audit(self, action, item_id):
        [audit] = [a for a in self.audits.values()
                   if a['action'] == action and a['item_id'] == item_id]
        return audit

    def store(self, embedder=None):
        return SimpleNamespace(
            runtime=SimpleNamespace(driver=self, embedder=embedder or EmbeddingPause()),
            settings=SimpleNamespace(provider_mode='personal', graph_limit=500),
            _group_locks={},
            _require_personal=lambda: None,
            authorize=self._authorize,
        )

    async def _authorize(self, actor, space_id, role):
        assert actor == ACTOR and space_id == SPACE
        return {'id': SPACE, 'kind': 'personal', 'group_id': 'personal-group'}

    @asynccontextmanager
    async def transaction(self):
        yield _MemoryTransaction(self)

    async def execute_query(self, query, **parameters):
        rows = self._answer(query, parameters)
        if (self.after_read and 'AS replaced_by_item_kind' in query
                and parameters.get('item_id') == self.after_read[0]):
            _, during = self.after_read
            self.after_read = None
            await during()
        return rows, None, None

    def _answer(self, query, p):
        if 'active_groups' in p or 'PERSONAL_PROJECT_RELATION*1..2' in query:
            return []
        if 'RETURN project' in query and 'FuliPersonalProject {project_id: $project_id}' in query:
            known = p['project_id'] in self.projects
            return [{'project': {'project_id': p['project_id']}}] if known else []
        if '[edge:RELATES_TO {group_id: $group_id}]' in query:
            return [_returned(query, self._view(item))
                    for item in self._preferences(p, 'relationship')]
        if 'MATCH (node:Entity {group_id: $group_id})' in query and 'fuli_profile_aspect' in query:
            return [_returned(query, self._view(item)) for item in self._preferences(p, 'entity')]
        if 'UNWIND $item_ids AS item_id' in query and 'AS lock_version' in query:
            return self._lock_versions(query, p)
        if "action: 'batch_confirm'" in query:
            return self._batch_confirm(query, p)
        if 'RETURN revision ORDER BY revision.created_at' in query:
            return [{'revision': {
                'id': revision['revision_id'], 'item_id': revision['item_id'], 'item_kind': revision['item_kind'],
                'action': revision['action'], 'reason': revision['reason'],
                'previous_json': revision.get('previous_json'), 'current_json': revision.get('current_json'),
                'created_at': revision['created_at'],
            }} for revision in self.revisions if revision.get('item_id') in p['item_ids']]
        item = self.items.get(p.get('item_id'))
        if 'RETURN properties(item) AS properties' in query:
            # A new version first takes the old one's write lock (rec#5 C7).
            if item.get('fuli_ai_review_lock_version', 0) != p['expected']:
                return []
            item['fuli_ai_review_lock_version'] = p['expected'] + 1
            return [{'properties': dict(item)}]
        if 'AS has_open_conflict' in query or 'AS replaced_by_item_kind' in query:
            return [_returned(query, self._view(item))] if item else []
        if 'item.fuli_replaced_by_item_kind = $replaced_by_item_kind' in query:
            return self._update_item(query, item, p)
        if 'CREATE (revision:FuliKnowledgeRevision' in query:
            self.revisions.append(dict(p))
            return []
        if "action: 'human_change'" in query:
            return self._human_change(query, item, p)
        if "audit.action = 'knowledge_feedback'" in query:
            return self._feedback(query, item, p)
        if 'count(DISTINCT audit.task_id)' in query:
            return [self._usage_aggregate(p)]
        if "audit.action = 'knowledge_used'" in query:
            return self._use(item, p)
        if 'item.fuli_qualified_use_count = $qualified_use_count' in query:
            return self._usage_scores(query, item, p)
        raise AssertionError(f'MemoryGraph does not understand this query:\n{query}')

    def _preferences(self, p, kind):
        return [
            item for item in self.items.values()
            if item['kind'] == kind
            and item.get('fuli_profile_aspect') and item.get('fuli_invalid_at') is None
            and item['fuli_confirmation_status'] in {'confirmed', 'agent_confirmed'}
            and (item['fuli_preference_scope'] == 'global'
                 or (item['fuli_preference_scope'] == 'project'
                     and item['fuli_preference_project_id'] == p['project_id']))
        ]

    def _view(self, item):
        status = item.get('fuli_confirmation_status')
        content = (
            {'name': item['name'], 'type': 'Entity', 'title': item['name'],
             'summary': item['summary'], 'instruction': item['summary']}
            if item['kind'] == 'entity' else
            {'type': item['name'], 'fact': item['fact'], 'instruction': item['fact'],
             'source_id': 'source-entity', 'target_id': 'target-entity',
             'source_name': item['source_name'], 'target_name': item['target_name']}
        )
        return {
            'id': item['uuid'], **content, 'key': item['uuid'],
            'evidence_ids': [], 'created_at': item['created_at'],
            'ai_review_lock_version': item.get('fuli_ai_review_lock_version', 0),
            'invalid_at': item.get('fuli_invalid_at'), 'has_open_conflict': False,
            'classification_state_explicit': item.get('fuli_origin_quadrant') is not None,
            'origin_quadrant': item.get('fuli_origin_quadrant') or 'known_known',
            'current_quadrant': item.get('fuli_current_quadrant') or 'known_known',
            'epistemic_status': item.get('fuli_epistemic_status') or 'confirmed',
            'confirmation_status': status or 'pending',
            'confirmation_state_explicit': (
                status is not None and item.get('fuli_confirmation_basis_json') is not None
            ),
            'confirmation_basis_json': item.get('fuli_confirmation_basis_json'),
            'reasoning_summary': item.get('fuli_reasoning_summary'),
            'profile_aspect': item.get('fuli_profile_aspect'),
            'preference_scope': item.get('fuli_preference_scope') or 'global',
            'preference_project_id': item.get('fuli_preference_project_id'),
            'preference_agent_id': None,
            'attributes_json': item.get('fuli_attributes_json'),
            'inheritance_mode': item.get('fuli_inheritance_mode') or 'local_only',
            'inherited_project_ids': item.get('fuli_inherited_project_ids') or [],
            'utility_score': item.get('fuli_utility_score') or 0.0,
            'confidence_score': item.get('fuli_confidence_score', 0.5),
            'qualified_use_count': item.get('fuli_qualified_use_count') or 0,
            'distinct_task_count': item.get('fuli_distinct_task_count') or 0,
            'last_used_at': item.get('fuli_last_used_at'),
            'usage_generation': item.get('fuli_usage_generation') or 1,
            'negative_evidence_count': item.get('fuli_negative_evidence_count') or 0,
            'requires_attention': item.get('fuli_requires_attention') is True,
            'last_feedback_kind': item.get('fuli_last_feedback_kind'),
            'last_feedback_at': item.get('fuli_last_feedback_at'),
            'negative_feedback_block_json': item.get('fuli_negative_feedback_block_json'),
            'replaced_by_item_id': item.get('fuli_replaced_by_item_id'),
            'replaced_by_item_kind': item.get('fuli_replaced_by_item_kind'),
        }

    def _use(self, item, p):
        if item is None or item['fuli_usage_generation'] != p['usage_generation']:
            return []
        recorded = p['audit_id'] not in self.audits
        if recorded:
            self.audits[p['audit_id']] = {
                'id': p['audit_id'], 'space_id': p['space_id'], 'item_id': p['item_id'],
                'item_kind': p['item_kind'], 'action': 'knowledge_used', 'task_id': p['task_id'],
                'use_kind': p['use_kind'], 'usage_generation': p['usage_generation'],
                'created_at': p['used_at'],
            }
        return [{'recorded': recorded}]

    def _usage_aggregate(self, p):
        uses = [a for a in self.audits.values()
                if a['action'] == 'knowledge_used' and a['item_id'] == p['item_id']
                and a['usage_generation'] == p['usage_generation']]
        return {
            'qualified_use_count': len(uses),
            'distinct_task_count': len({a['task_id'] for a in uses}),
            'applied_count': sum(a['use_kind'] == 'applied' for a in uses),
            'cited_count': sum(a['use_kind'] == 'cited' for a in uses),
            'last_used_at': max((a['created_at'] for a in uses), default=None),
        }

    def _usage_scores(self, query, item, p):
        if item is None or item['fuli_usage_generation'] != p['usage_generation']:
            return []
        _bump(query, item)
        item.update(
            fuli_utility_score=p['utility_score'], fuli_confidence_score=p['confidence_score'],
            fuli_qualified_use_count=p['qualified_use_count'],
            fuli_distinct_task_count=p['distinct_task_count'], fuli_last_used_at=p['last_used_at'],
            fuli_confirmation_status=p['confirmation_status'],
            fuli_confirmation_basis_json=p['confirmation_basis_json'],
            fuli_epistemic_status=(
                'confirmed' if p['confirmation_status'] == 'confirmed' else 'observed'
            ),
        )
        if p['promoted'] and p['audit_id'] in self.audits:
            self.audits[p['audit_id']].update(outcome='agent_confirmed', promotion=True)
        return [{'confirmation_status': item['fuli_confirmation_status']}]

    def _feedback(self, query, item, p):
        if item is None or item['fuli_usage_generation'] != p['usage_generation']:
            return []
        _bump(query, item)
        recorded = p['audit_id'] not in self.audits
        if recorded:
            self.audits[p['audit_id']] = {
                'id': p['audit_id'], 'space_id': p['space_id'], 'item_id': p['item_id'],
                'item_kind': p['item_kind'], 'action': 'knowledge_feedback',
                'task_id': p['task_id'], 'feedback_kind': p['feedback_kind'],
                'reported_by_kind': p['reported_by_kind'], 'reason': p['reason'],
                'usage_generation': p['usage_generation'], 'outcome': 'requires_attention',
                'created_at': p['feedback_at'],
            }
            status = p['next_confirmation_status']
            item.update(
                fuli_utility_score=p['utility_score'], fuli_confidence_score=p['confidence_score'],
                fuli_confirmation_status=status,
                fuli_confirmation_basis_json=p['next_confirmation_basis_json'],
                fuli_epistemic_status='confirmed' if status == 'confirmed' else 'observed',
                fuli_negative_evidence_count=item['fuli_negative_evidence_count'] + 1,
                fuli_requires_attention=True, fuli_last_feedback_kind=p['feedback_kind'],
                fuli_last_feedback_at=p['feedback_at'],
            )
            if 'item.fuli_negative_feedback_block_json = coalesce(' in query:
                item['fuli_negative_feedback_block_json'] = (
                    item.get('fuli_negative_feedback_block_json')
                    or p['negative_feedback_block_json']
                )
        return [_returned(query, {**self._view(item), 'recorded': recorded})]

    def _update_item(self, query, item, p):
        previous_version = item.get('fuli_ai_review_lock_version', 0)
        _bump(query, item)
        compare_and_set = (
            'WITH item WHERE item.fuli_ai_review_lock_version = $expected_lock_version + 1'
            in ' '.join(query.split())
        )
        moved = item['fuli_ai_review_lock_version'] != p.get('expected_lock_version', 0) + 1
        if compare_and_set and moved:
            # Production raises here and its transaction rolls the bump back.
            item['fuli_ai_review_lock_version'] = previous_version
            return []
        for name in [
            'name', 'summary', 'fact', 'origin_quadrant', 'current_quadrant', 'epistemic_status',
            'confirmation_status', 'confirmation_basis_json', 'reasoning_summary',
            'profile_aspect', 'preference_scope', 'preference_project_id', 'inheritance_mode',
            'inherited_project_ids', 'utility_score', 'confidence_score', 'qualified_use_count',
            'distinct_task_count', 'last_used_at', 'usage_generation', 'negative_evidence_count',
            'requires_attention', 'last_feedback_kind', 'last_feedback_at',
            'replaced_by_item_id', 'replaced_by_item_kind', 'negative_feedback_block_json',
        ]:
            if name in p:
                item[name if name in {'name', 'summary', 'fact'} else f'fuli_{name}'] = p[name]
        item['fuli_invalid_at'] = p['invalid_at']
        return [{'item_id': item['uuid']}]

    def _lock_versions(self, query, p):
        kind = 'relationship' if 'RELATES_TO' in query else 'entity'
        rows = []
        for item_id in p['item_ids']:
            item = self.items.get(item_id)
            if item is None or item['kind'] != kind:
                continue
            _bump(query, item)
            rows.append({'item_id': item_id,
                         'lock_version': item['fuli_ai_review_lock_version']})
        return rows

    def _batch_confirm(self, query, p):
        def valid(row):
            item = self.items.get(row['item_id'])
            content = (
                item['name'] == row['expected_name']
                and item['summary'] == row['expected_summary']
                if row['item_kind'] == 'entity' else item['fact'] == row['expected_fact']
            ) if item else False
            return (content and item.get('fuli_invalid_at') is None
                    and item['fuli_confirmation_status'] == 'pending'
                    and item['fuli_origin_quadrant'] == row['expected_origin_quadrant'])
        if not all(valid(row) for row in p['items']):
            return []
        clears_block = 'item.fuli_negative_feedback_block_json = NULL' in query
        for row in p['items']:
            item = self.items[row['item_id']]
            _bump(query, item)
            item.update(fuli_epistemic_status='confirmed', fuli_confirmation_status='confirmed',
                        fuli_confirmation_basis_json=row['confirmation_basis_json'])
            if clears_block:
                item['fuli_negative_feedback_block_json'] = None
            self.revisions.append({
                'action': 'batch_confirm', 'item_id': row['item_id'],
                'previous_json': row['previous_json'], 'current_json': row['current_json'],
            })
        count = len(p['items'])
        return [{'valid_count': count, 'confirmed_count': count}]

    def _human_change(self, query, item, p):
        _bump(query, item)
        version = item.get('fuli_human_change_version', 0) + 1
        item.update(fuli_human_edited=True, fuli_human_change_version=version,
                    fuli_human_change_status='unseen')
        self.audits[p['audit_id']] = {
            'id': p['audit_id'], 'item_id': p['item_id'], 'action': 'human_change',
            'operation': p['operation'], 'reason': p['reason'], 'created_at': p['changed_at'],
        }
        return [{'human_change_version': version}]


class _MemoryTransaction:
    def __init__(self, graph):
        self.graph = graph

    async def run(self, query, **parameters):
        return AsyncRows(self.graph._answer(query, parameters))


class EmbeddingPause:
    """No-network embedder; `during` runs while a write awaits its embedding."""

    def __init__(self):
        self.during = None

    async def create_batch(self, values):
        during, self.during = self.during, None
        if during:
            await during()
        return [[float(len(value))] for value in values]


def _bump(query, item):
    if 'item.fuli_ai_review_lock_version =' in query:
        item['fuli_ai_review_lock_version'] = item.get('fuli_ai_review_lock_version', 0) + 1


def _returned(query, view):
    return {key: value for key, value in view.items() if re.search(rf'\bAS {key}\b', query)}


def basis(status):
    value = {
        'existence_reason': 'Synthetic fixture preference.',
        'quadrant_reason': 'Synthetic fixture quadrant.',
        'proposed_by': {'kind': 'agent', 'label': 'Codex'},
    }
    if status == 'confirmed':
        value.update(confirmed_by={'kind': 'user', 'label': '当前用户'},
                     confirmed_at='2026-10-01T00:00:00+00:00')
    if status == 'agent_confirmed':
        value.update(confirmed_by={'kind': 'agent', 'label': 'Fuli usage evidence policy'},
                     confirmed_at='2026-10-01T00:00:00+00:00',
                     agent_policy_version='agent-usage-v1')
    return value
