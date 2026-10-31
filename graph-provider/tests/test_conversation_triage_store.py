"""Triage store rules on a synthetic driver; Cypher shapes stay deliberately simple."""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from fuli_graph.conversation_triage_models import (
    ConversationTopicDecline, ConversationTopicFormation, ConversationTopicQuery, ConversationTopicReopening,
    ConversationTriageWrite,
)
from fuli_graph.provider_values import stable_uuid
from fuli_graph.store_conversation_triage import StoreConversationTriage

SPACE = 'synthetic-space'
PENDING = stable_uuid('global-conversation-scope', SPACE, 'employee.assistant')


class TriageDriver:
    def __init__(self, conversations):
        self.conversations = conversations
        self.labels = {}
        self.declines = {}
        self.queries = []

    async def execute_query(self, query, **p):
        self.queries.append(query)
        if 'MERGE (t:FuliConversationTriage' in query:
            if self.conversations.get(p['id']) != p['scope']:
                return [], None, None
            label =self.labels.setdefault(p['id'], {'id': p['id'], 'space_id': p['space_id']})
            kept = None if p['source'] != 'host' else (
                'formed_project' if label.get('formed_project_id') else
                'user_label' if label.get('source') == 'user' else None)
            if not kept:
                label.update(p['label'])
            return [{'t': dict(label), 'kept': kept}], None, None
        open_labels = [t for t in self.labels.values() if t['space_id'] == p['space_id']
                       and t['kind'] == 'topic' and not t.get('formed_project_id')]
        if 'RETURN count(t)' in query:
            return [{'count': sum(t['topic_key'] == p['key'] for t in open_labels)}], None, None
        if 'MERGE (d:FuliConversationTopicDecline' in query:
            self.declines[(p['space_id'], p['key'])] = p['count']
            return [], None, None
        if 'collect(t.topic)' in query:
            groups = {}
            for label in open_labels:
                if p['key'] is None or label['topic_key'] == p['key']:
                    groups.setdefault(label['topic_key'], []).append(label)
            rows = sorted((g for g in groups.values() if len(g) >= p['min_count']), key=lambda g: (
                -any(t['source'] == 'user' for t in g), -len(g), ''.join(sorted(t['labeled_at'] for t in g))))
            return [{'topic': g[0]['topic'], 'count': len(g), 'days': len({t['labeled_at'][:10] for t in g}),
                     'last': max(t['labeled_at'] for t in g),
                     'declined_count': self.declines.get((p['space_id'], g[0]['topic_key']))}
                    for g in rows[:p['limit']]], None, None
        if 'SET t.formed_project_id' in query:
            ids = []
            for label in self.labels.values():
                if label['space_id'] == p['space_id'] and label.get('topic_key') == p['key'] and \
                        label['kind'] == 'topic' and label.get('formed_project_id') in (None, p['project']):
                    label['formed_project_id'] = p['project']
                    ids.append({'id': label['id']})
            return sorted(ids, key=lambda row: row['id']), None, None
        if 'REMOVE t.formed_project_id' in query:
            ids = []
            for label in self.labels.values():
                if label['space_id'] == p['space_id'] and label.get('topic_key') == p['key'] and                         label['kind'] == 'topic' and label.get('formed_project_id') == p['project']:
                    label.pop('formed_project_id'); label.pop('formed_at', None)
                    ids.append({'id': label['id']})
            return sorted(ids, key=lambda row: row['id']), None, None
        raise AssertionError(query)


class TriageStore(StoreConversationTriage):
    def __init__(self, conversations, projects=('garden',)):
        self.runtime = SimpleNamespace(driver=TriageDriver(conversations))
        self.projects = set(projects)

    def _require_personal(self):
        return None

    async def authorize(self, actor, space_id, role):
        return {'id': space_id}

    async def get_personal_project(self, actor, space_id, project_id):
        if project_id not in self.projects:
            raise HTTPException(404, 'personal project not found')
        return {'project_id': project_id}


def write(conversation, **changes):
    return ConversationTriageWrite(**{'personal_space_id': SPACE, 'conversation_id': conversation,
                                      'kind': 'topic', 'topic': 'Garden  Planning', **changes})


@pytest.mark.asyncio
async def test_topic_labels_accumulate_per_normalized_topic():
    store = TriageStore({'c1': PENDING, 'c2': PENDING, 'c3': PENDING})
    counts = [(await store.record_conversation_triage({}, write(c, topic=t)))['topic_count']
              for c, t in (('c1', 'Garden Planning'), ('c2', 'garden planning'), ('c3', 'Other'))]
    assert counts == [1, 2, 1]
    topics = await store.query_conversation_topics({}, ConversationTopicQuery(personal_space_id=SPACE))
    assert [(t['topic'], t['count'], t['days'], t['declined_count']) for t in topics['topics']] == [
        ('Garden Planning', 2, 1, None), ('Other', 1, 1, None)]


@pytest.mark.asyncio
async def test_a_topic_reports_its_days_and_the_count_a_person_declined_at():
    store = TriageStore({f'c{i}': PENDING for i in range(4)})
    for i in range(3):
        await store.record_conversation_triage({}, write(f'c{i}'))
    store.runtime.driver.labels['c0']['labeled_at'] = '2026-10-17T09:00:00+00:00'
    await store.record_conversation_triage({}, write('c3', topic='Other'))
    query = ConversationTopicQuery(personal_space_id=SPACE, topic='garden planning', min_count=3)
    [garden] = (await store.query_conversation_topics({}, query))['topics']
    assert (garden['topic'], garden['count'], garden['days']) == ('Garden Planning', 3, 2)
    declined = await store.decline_conversation_topic({}, ConversationTopicDecline(
        personal_space_id=SPACE, topic='GARDEN planning'))
    assert declined == {'topic': 'GARDEN planning', 'declined_count': 3}
    [garden] = (await store.query_conversation_topics({}, query))['topics']
    assert garden['declined_count'] == 3
    assert (await store.query_conversation_topics({}, ConversationTopicQuery(
        personal_space_id=SPACE, topic='Other', min_count=3)))['topics'] == []
    with pytest.raises(HTTPException) as error:
        await store.decline_conversation_topic({}, ConversationTopicDecline(personal_space_id=SPACE, topic='Nothing'))
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_only_unclaimed_conversations_of_this_space_are_labelled():
    store = TriageStore({'project-chat': 'some-project-scope'})
    with pytest.raises(HTTPException) as error:
        await store.record_conversation_triage({}, write('project-chat'))
    assert error.value.status_code == 404
    store = TriageStore({'c1': PENDING})
    with pytest.raises(HTTPException):
        await store.record_conversation_triage({}, write('c1', kind='project', topic=None,
                                                         personal_project_id='missing'))


@pytest.mark.asyncio
async def test_a_person_correction_and_a_formed_project_outrank_later_host_labels():
    store = TriageStore({'c1': PENDING, 'c2': PENDING})
    await store.record_conversation_triage({}, write('c1', kind='one_off', topic=None, source='user'))
    kept = await store.record_conversation_triage({}, write('c1'))
    assert (kept['kept'], kept['triage']['kind']) == ('user_label', 'one_off')
    await store.record_conversation_triage({}, write('c2'))
    formed = await store.form_conversation_topic({}, ConversationTopicFormation(
        personal_space_id=SPACE, topic='garden planning', personal_project_id='garden'))
    assert formed['conversation_ids'] == ['c2']
    relabel = await store.record_conversation_triage({}, write('c2', kind='one_off', topic=None))
    assert (relabel['kept'], relabel['triage']['formed_project_id']) == ('formed_project', 'garden')
    corrected = await store.record_conversation_triage({}, write('c2', kind='one_off', topic=None, source='user'))
    assert corrected['triage']['kind'] == 'one_off'


@pytest.mark.asyncio
async def test_formation_is_idempotent_and_closes_the_topic():
    store = TriageStore({f'c{i}': PENDING for i in range(3)})
    for i in range(3):
        await store.record_conversation_triage({}, write(f'c{i}'))
    request = ConversationTopicFormation(personal_space_id=SPACE, topic='Garden Planning',
                                         personal_project_id='garden')
    first = await store.form_conversation_topic({}, request)
    again = await store.form_conversation_topic({}, request)
    assert first['conversation_ids'] == again['conversation_ids'] == ['c0', 'c1', 'c2']
    assert (await store.query_conversation_topics({}, ConversationTopicQuery(personal_space_id=SPACE))) == {'topics': []}


@pytest.mark.asyncio
async def test_reopening_undoes_a_formation_and_waits_for_the_topic_to_grow():
    store = TriageStore({f'c{i}': PENDING for i in range(3)})
    for i in range(3):
        await store.record_conversation_triage({}, write(f'c{i}'))
    await store.form_conversation_topic({}, ConversationTopicFormation(
        personal_space_id=SPACE, topic='Garden Planning', personal_project_id='garden'))
    reopened = await store.reopen_conversation_topic({}, ConversationTopicReopening(
        personal_space_id=SPACE, topic='garden planning', personal_project_id='garden'))
    assert reopened == {'topic': 'garden planning', 'personal_project_id': 'garden',
                        'conversation_ids': ['c0', 'c1', 'c2'], 'declined_count': 3}
    [garden] = (await store.query_conversation_topics({}, ConversationTopicQuery(personal_space_id=SPACE)))['topics']
    assert (garden['count'], garden['declined_count']) == (3, 3)
    # Only conversations formed into that project; a second undo finds none.
    with pytest.raises(HTTPException) as error:
        await store.reopen_conversation_topic({}, ConversationTopicReopening(
            personal_space_id=SPACE, topic='garden planning', personal_project_id='garden'))
    assert error.value.status_code == 404


def test_a_label_carries_exactly_what_its_kind_needs():
    for changes in ({'kind': 'project', 'topic': None}, {'kind': 'topic', 'topic': None},
                    {'kind': 'one_off'}, {'kind': 'topic', 'personal_project_id': 'garden'}):
        with pytest.raises(ValidationError):
            write('c1', **changes)


class ListDriver:
    async def execute_query(self, query, **parameters):
        assert 'FuliConversationTriage' in query
        return [{'c': {'id': 'c1', 'summary': 'One', 'status': 'reported', 'revision': 2, 'last_activity': 'x'},
                 't': {'kind': 'topic', 'topic': 'Garden', 'source': 'user', 'personal_project_id': None,
                       'labeled_at': 'y', 'formed_project_id': None}},
                {'c': {'id': 'c2', 'summary': 'Two', 'status': 'reported', 'revision': 1, 'last_activity': 'x'},
                 't': None}], None, None


@pytest.mark.asyncio
async def test_conversation_lists_carry_their_triage_label():
    from fuli_graph.agent_conversation_models import ConversationQuery, ConversationPolicy
    from fuli_graph.store_agent_conversations import StoreAgentConversations

    class ListStore(StoreAgentConversations):
        def __init__(self):
            self.runtime = SimpleNamespace(driver=ListDriver())

        async def _conversation_scope(self, actor, request, *, write=False):
            return 'scope'

        async def _conversation_policy(self, scope):
            return ConversationPolicy()

    result = await ListStore().query_conversations({}, ConversationQuery(
        personal_space_id=SPACE, personal_project_id=None, agent_id='employee.assistant', mode='list'))
    assert [row['triage'] and row['triage']['topic'] for row in result['conversations']] == ['Garden', None]
    assert result['conversations'][0]['triage']['source'] == 'user'


@pytest.mark.asyncio
async def test_a_host_label_cannot_overwrite_a_correction_made_while_it_was_running():
    """SOL's #68 repro: the host prepares a label, a person corrects meanwhile, the host then writes."""
    store = TriageStore({'c1': PENDING})
    await store.record_conversation_triage({}, write('c1'))
    await store.record_conversation_triage({}, write('c1', kind='one_off', topic=None, source='user'))
    late = await store.record_conversation_triage({}, write('c1', topic='Late host topic'))
    assert late['kept'] == 'user_label'
    assert (late['triage']['kind'], late['triage']['source']) == ('one_off', 'user')
    # The decision and the write happen in one statement; nothing reads the label first.
    assert not any(q.startswith('MATCH (t:FuliConversationTriage {id: $id}) RETURN t') for q in store.runtime.driver.queries)

@pytest.mark.asyncio
async def test_the_conversation_lock_comes_before_the_first_label_is_created():
    """SOL's #93 repro: two first labels must not each MERGE their own node."""
    store = TriageStore({'c1': PENDING})
    await store.record_conversation_triage({}, write('c1'))
    query = store.runtime.driver.queries[0]
    assert query.index('SET c._triage_lock') < query.index('MERGE (t:FuliConversationTriage')
