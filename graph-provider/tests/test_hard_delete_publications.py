"""Public submission provenance is shown by the real hard-delete preview."""
import json
from types import SimpleNamespace

import pytest

from fuli_graph import knowledge_hard_delete as deletion
from fuli_graph.knowledge_hard_delete_models import KnowledgeHardDeleteItem, KnowledgeHardDeleteRef
from fuli_graph.provider_values import stable_uuid
from fuli_graph.knowledge_hard_delete_publications import publications_for_sources


class PreviewDriver:
    def __init__(self, drafts):
        self.drafts = drafts
        self.queries = []

    async def execute_query(self, query, **params):
        self.queries.append(query)
        if 'FuliPublicationDraft' in query:
            assert params['space_id'] == 'space'
            assert 'SUBSCRIBES_TO' in query
            assert 'subscription.provider_url = draft.provider_url' in query
            assert 'subscription.project_id = draft.target_project_id' in query
            return ([{'draft': draft, 'project_name': 'Readable public project' if draft['id'] == 'exact' else None}
                     for draft in self.drafts], None, None)
        if 'RETURN episode.uuid AS episode_id' in query:
            return ([{'episode_id': stable_uuid('group', 'episode', 'original-capture'),
                      'session_id': 'session', 'source_application': 'codex', 'source_turn_id': 'turn'}], None, None)
        if 'AS episode,' in query:
            return ([], None, None)
        if 'count(mention)' in query:
            return ([{'mentions': 0}], None, None)
        if 'RETURN DISTINCT item.uuid' in query:
            return ([], None, None)
        raise AssertionError(query)


async def setup_preview(monkeypatch, drafts):
    driver = PreviewDriver(drafts)

    async def authorize(*args):
        return {'id': 'space', 'group_id': 'group', 'kind': 'personal'}

    store = SimpleNamespace(runtime=SimpleNamespace(driver=driver), authorize=authorize, _require_personal=lambda: None)

    async def absent(*args):
        return None

    async def current(*args):
        return {'name': 'Synthetic item'}

    async def versions(*args):
        return [{'item_id': 'item'}]

    async def items(*args):
        return ([KnowledgeHardDeleteItem(item_kind='entity', item_id='item', role='item', title='Synthetic item',
                                         content='Synthetic words', status='current')], [['entity', 'item', 0]])

    async def records(*args):
        return {}

    async def dependents(*args):
        return []

    monkeypatch.setattr(deletion, 'require_not_hard_deleted', absent)
    monkeypatch.setattr(deletion, '_read_item', current)
    monkeypatch.setattr(deletion, 'version_chain', versions)
    monkeypatch.setattr(deletion, '_item_rows', items)
    monkeypatch.setattr(deletion, '_record_ids', records)
    monkeypatch.setattr(deletion, '_dependents', dependents)
    return store, driver


def draft(identity, key='original-capture', status='submitted', **source):
    return {'id': identity, 'status': status, 'provider_url': 'https://public.example',
            'target_project_id': 'public-project', 'shared_proposal_id': 'proposal',
            'payload': json.dumps({'idempotency_key': key, **source})}


@pytest.mark.asyncio
async def test_preview_reports_exact_episode_and_turn_provenance_and_no_fake_withdrawal(monkeypatch):
    drafts = [draft('exact'), draft('turn', 'different-key', session_id='session',
              source_application='codex', source_turn_id='turn'),
              draft('unrelated', 'other', session_id='session', source_application='codex'),
              draft('wrong-app', 'other', session_id='session', source_application='claude', source_turn_id='turn'),
              draft('pending', status='pending')]
    store, driver = await setup_preview(monkeypatch, drafts)
    result = await deletion.preview_hard_delete(store, {'id': 'owner'}, 'item',
                KnowledgeHardDeleteRef(personal_space_id='space', item_kind='entity'))
    assert [row.draft_id for row in result.publications] == ['exact', 'turn']
    assert [row.project_name for row in result.publications] == ['Readable public project', None]
    for row in result.publications:
        assert row.project_id == 'public-project'
        assert row.withdrawal_url is None
        assert row.withdrawal_status == 'unavailable'
        assert row.local_delete_retracts is False
        assert row.source_episode_ids == [stable_uuid('group', 'episode', 'original-capture')]
    assert all('SET ' not in query and 'DELETE ' not in query for query in driver.queries)
    original_digest = result.preview_id
    driver.drafts = []
    changed = await deletion.preview_hard_delete(store, {'id': 'owner'}, 'item',
                KnowledgeHardDeleteRef(personal_space_id='space', item_kind='entity'))
    assert changed.preview_id != original_digest, 'publication warning changes require a fresh confirmation'


@pytest.mark.asyncio
@pytest.mark.parametrize('scope,expected', [('episode', ['direct']), ('session', ['direct', 'other-turn'])])
async def test_source_publications_do_not_require_a_local_episode(scope, expected):
    drafts = [draft('direct', session_id='session', source_application='codex', source_turn_id='turn'),
              draft('other-turn', session_id='session', source_application='codex', source_turn_id='other'),
              draft('other-client', session_id='session', source_application='claude', source_turn_id='turn'),
              draft('other-session', session_id='other', source_application='codex', source_turn_id='turn'),
              draft('pending', status='pending', session_id='session', source_application='codex', source_turn_id='turn')]

    async def query(cypher, **params):
        if 'FuliPublicationDraft' in cypher:
            return ([{'draft': value, 'project_name': None} for value in drafts], None, None)
        return [], None, None

    store = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=query)))
    source_range = SimpleNamespace(whole_session=scope == 'session', source_application='codex', session_id='session', turn_id='turn')
    result = await publications_for_sources(store, {'id': 'space', 'group_id': 'group'}, [], source_range=source_range)
    assert [row.draft_id for row in result] == expected
    assert all(row.source_episode_ids == [] for row in result)


@pytest.mark.asyncio
async def test_scrubbed_submission_is_found_by_preserved_identity_after_episode_is_gone():
    async def query(cypher, **params):
        if 'FuliPublicationDraft' in cypher:
            return ([{'draft': {'id': 'receipt', 'status': 'submitted',
                'provider_url': 'https://public.example', 'target_project_id': 'project',
                'shared_proposal_id': 'proposal', 'source_identity': json.dumps({'episode_id': 'deleted-episode'}),
                'payload_scrubbed_by': 'deletion'}, 'project_name': None}], None, None)
        return [], None, None
    store = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=query)))
    found = await publications_for_sources(store, {'id': 'space', 'group_id': 'group'}, [], ['deleted-episode'])
    assert [row.draft_id for row in found] == ['receipt']
    assert found[0].source_episode_ids == ['deleted-episode']
