"""rec#11 D-86: a promoted topic's session knowledge moves into its project,
and an undo returns what nobody changed since. Synthetic driver and an
in-memory knowledge layer; the scope-change revisions it records are the only
record the undo reads."""
import json

import pytest
from fastapi import HTTPException

from fuli_graph import knowledge_session_migration, topic_knowledge_migration
from fuli_graph.conversation_triage_models import ConversationTopicFormation, ConversationTopicReopening
from fuli_graph.knowledge_item_view import scope_snapshot
from fuli_graph.knowledge_item_view_models import KnowledgeItemScope, KnowledgeScopeProject
from fuli_graph.system_agents import SYSTEM_ASSISTANT_AGENT_ID
from fuli_graph.temporary_project_scope import session_temporary_project_id
from test_conversation_triage_store import PENDING, SPACE, TriageStore, write

HELD = session_temporary_project_id(SPACE, 'codex', 'session-garden')
OTHER = session_temporary_project_id(SPACE, 'codex', 'session-elsewhere')
PERSON = 'person'


class Knowledge:
    """Items with a scope and a revision list, as the Provider's scope edit keeps them."""

    def __init__(self):
        self.items = {}
        self.revisions = []

    def add(self, item_id, project, status='undetermined', matched=False):
        self.items[item_id] = {'project': project, 'status': status, 'matched': matched}

    def scope(self, item_id):
        item = self.items[item_id]
        temporary = item['project'].startswith('temporary-')
        return KnowledgeItemScope(kind='temporary' if temporary else 'projects', status=item['status'],
                                  projects=[KnowledgeScopeProject(id=item['project'], temporary=temporary)])

    def version(self, item_id):
        return sum(revision['item_id'] == item_id for revision in self.revisions)

    def change(self, item_id, author, project, status=None, reason='a person moved it'):
        before = scope_snapshot(self.scope(item_id))
        self.items[item_id].update(project=project, status=status or 'set')
        self.revisions.append({'item_kind': 'entity', 'item_id': item_id, 'action': 'scope_change',
                               'created_by': author, 'reason': reason,
                               'previous_json': json.dumps({'scope': before}),
                               'current_json': json.dumps({'scope': scope_snapshot(self.scope(item_id))})})

    def latest_assistant_moves(self):
        newest = {}
        for revision in self.revisions:
            newest[revision['item_id']] = revision
        return [revision for revision in newest.values()
                if revision['action'] == 'scope_change' and revision['created_by'] == SYSTEM_ASSISTANT_AGENT_ID]


@pytest.fixture
def knowledge(monkeypatch):
    state = Knowledge()

    async def held_items(store, space, temporary_id):
        return [('entity', item_id, {}) for item_id, item in state.items.items()
                if item['project'] == temporary_id]

    async def edit_revision(store, space, item_kind, item_id):
        return state.version(item_id)

    async def place_scope_as(scoped, actor, space, author_id, item_kind, item_id, *, expected_version,
                             project_ids, reason, scope_status=None):
        assert space['group_id'] == f'group-{SPACE}'
        if expected_version != state.version(item_id):
            raise HTTPException(409, {'code': 'stale_version'})
        if state.items[item_id]['matched'] and not project_ids[0].startswith('temporary-'):
            raise HTTPException(409, {'code': 'project_has_match'})
        state.change(item_id, author_id, project_ids[0], scope_status, reason)
        return {'item_kind': item_kind, 'item_id': item_id}

    async def target_project(store, actor, space, project_id):
        return {'id': project_id}

    async def read_item(store, space, item_id, item_kind):
        return {} if item_id in state.items else None

    async def item_scope(store, space, item_kind, item_id, current):
        return state.scope(item_id)

    async def latest_moves(scoped, space):
        return state.latest_assistant_moves()

    for module, name, value in (
            (knowledge_session_migration, 'held_items', held_items),
            (knowledge_session_migration, 'edit_revision', edit_revision),
            (knowledge_session_migration, 'place_scope_as', place_scope_as),
            (knowledge_session_migration, '_target_project', target_project),
            (topic_knowledge_migration, 'edit_revision', edit_revision),
            (topic_knowledge_migration, 'place_scope_as', place_scope_as),
            (topic_knowledge_migration, '_read_item', read_item),
            (topic_knowledge_migration, 'item_scope', item_scope),
            (topic_knowledge_migration, '_latest_assistant_moves', latest_moves)):
        monkeypatch.setattr(module, name, value)
    return state


async def formed_topic(conversations=('c0', 'c1', 'c2')):
    store = TriageStore({conversation: PENDING for conversation in conversations})
    for conversation in conversations:
        await store.record_conversation_triage({}, write(conversation))
    # c0 and c1 were the same host session; c2 left no session behind.
    store.runtime.driver.sessions.update({'c0': ('codex', 'session-garden'), 'c1': ('codex', 'session-garden')})
    return store


async def form(store):
    return await store.form_conversation_topic({}, ConversationTopicFormation(
        personal_space_id=SPACE, topic='Garden  Planning', personal_project_id='garden'))


async def reopen(store):
    return await store.reopen_conversation_topic({}, ConversationTopicReopening(
        personal_space_id=SPACE, topic='Garden Planning', personal_project_id='garden'))


@pytest.mark.asyncio
async def test_promotion_moves_what_the_topics_sessions_hold_and_nothing_else(knowledge):
    knowledge.add('gate', HELD)
    knowledge.add('lesson', HELD, status='set')
    knowledge.add('duplicate', HELD, matched=True)
    knowledge.add('elsewhere', OTHER)
    store = await formed_topic()
    formed = await form(store)
    assert formed['knowledge'] == {'moved': 2, 'kept': 1}
    assert {item: state['project'] for item, state in knowledge.items.items()} == {
        'gate': 'garden', 'lesson': 'garden', 'duplicate': HELD, 'elsewhere': OTHER}
    moves = [revision for revision in knowledge.revisions if revision['created_by'] == SYSTEM_ASSISTANT_AGENT_ID]
    assert {revision['item_id'] for revision in moves} == {'gate', 'lesson'}
    assert all('话题「Garden Planning」' in revision['reason'] for revision in moves)
    # The lock is taken before the formation writes, in the same transaction.
    queries = store.runtime.driver.queries
    assert queries.index(next(q for q in queries if 'space._knowledge_lock' in q)) < queries.index(
        next(q for q in queries if 'SET t.formed_project_id' in q))
    # Formed again: nothing left to move.
    assert (await form(store))['knowledge'] == {'moved': 0, 'kept': 1}


@pytest.mark.asyncio
async def test_undo_returns_what_moved_unless_someone_changed_it_since(knowledge):
    knowledge.add('gate', HELD)
    knowledge.add('lesson', HELD, status='set')
    knowledge.add('placed', HELD)
    knowledge.add('mine', 'garden', status='set')
    store = await formed_topic()
    assert (await form(store))['knowledge'] == {'moved': 3, 'kept': 0}
    # A person moved one on after the promotion; it stays where they put it.
    knowledge.change('placed', PERSON, 'beta')
    reopened = await reopen(store)
    assert reopened['knowledge'] == {'returned': 2, 'kept': 0}
    assert knowledge.scope('gate') == KnowledgeItemScope(kind='temporary', status='undetermined', projects=[
        KnowledgeScopeProject(id=HELD, temporary=True)]), 'back as it was held: scope undetermined'
    assert (knowledge.items['lesson']['project'], knowledge.items['lesson']['status']) == (HELD, 'set')
    assert knowledge.items['placed']['project'] == 'beta'
    assert knowledge.items['mine']['project'] == 'garden', 'what the project already had stays'
    returns = [revision for revision in knowledge.revisions if '撤销' in revision['reason']]
    assert [revision['created_by'] for revision in returns] == [SYSTEM_ASSISTANT_AGENT_ID] * 2


@pytest.mark.asyncio
async def test_undo_leaves_an_item_whose_scope_changed_without_a_revision(knowledge, monkeypatch):
    knowledge.add('gate', HELD)
    store = await formed_topic()
    await form(store)
    # 加入项目 added a project without a scope revision: no longer what the move left.
    original = topic_knowledge_migration.item_scope

    async def widened(store, space, item_kind, item_id, current):
        scope = await original(store, space, item_kind, item_id, current)
        return scope.model_copy(update={'projects': [*scope.projects, KnowledgeScopeProject(id='beta')]})

    monkeypatch.setattr(topic_knowledge_migration, 'item_scope', widened)
    assert (await reopen(store))['knowledge'] == {'returned': 0, 'kept': 1}
    assert knowledge.items['gate']['project'] == 'garden'


@pytest.mark.asyncio
async def test_undo_reads_only_moves_from_this_topics_sessions_into_this_project(knowledge):
    knowledge.add('gate', HELD)
    knowledge.add('other-topic', OTHER)
    store = await formed_topic()
    await form(store)
    # Another topic's promotion into the same project, from another session.
    knowledge.change('other-topic', SYSTEM_ASSISTANT_AGENT_ID, 'garden', reason='Astro 将话题「Other」升级为项目')
    assert (await reopen(store))['knowledge'] == {'returned': 1, 'kept': 0}
    assert knowledge.items['other-topic']['project'] == 'garden'
    # Undone once: the return is now the newest revision, so nothing is read twice.
    assert [revision['item_id'] for revision in knowledge.latest_assistant_moves()
            if json.loads(revision['previous_json'])['scope']['kind'] == 'temporary'] == ['other-topic']


@pytest.mark.asyncio
async def test_a_failure_other_than_a_match_fails_the_whole_formation(knowledge, monkeypatch):
    knowledge.add('gate', HELD)

    async def broken(*args, **kwargs):
        raise HTTPException(409, {'code': 'stale_version'})

    monkeypatch.setattr(knowledge_session_migration, 'place_scope_as', broken)
    store = await formed_topic()
    with pytest.raises(HTTPException) as error:
        await form(store)
    # It propagates out of the formation's transaction, which Neo4j then rolls back.
    assert error.value.detail['code'] == 'stale_version'
