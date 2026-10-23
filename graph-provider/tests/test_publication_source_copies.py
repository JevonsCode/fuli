"""B7 erases local draft bodies by provenance, including non-pending copies."""
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from fuli_graph.publication_source_copies import drafts_for_sources, scrub_publication_drafts
from fuli_graph.provider_values import stable_uuid


@pytest.mark.asyncio
async def test_all_draft_states_are_scrubbed_by_exact_identity_and_pending_is_terminal():
    text = 'Synthetic deleted source text'
    states = ['pending', 'submitted', 'kept_personal', 'ignored']
    saved = {state: {'id': state, 'status': state, 'payload': json.dumps({
        'idempotency_key': 'capture', 'source_description': text}),
        'shared_proposal_id': 'proposal' if state == 'submitted' else None} for state in states}
    saved['unrelated'] = {'id': 'unrelated', 'status': 'pending', 'payload': json.dumps({
        'idempotency_key': 'different', 'source_description': text})}

    async def query(cypher, **params):
        assert params['space_id'] == 'space'
        if 'SET draft.payload' not in cypher:
            return ([{'draft': row.copy(), 'project_name': None} for row in saved.values()], None, None)
        row = saved[params['draft_id']]
        row.update(payload=None, source_identity=params['source_identity'],
                   payload_scrubbed_by=params['deletion_id'], payload_scrubbed_at=params['deleted_at'])
        if row['status'] == 'pending':
            row['status'] = 'source_deleted'
        return ([], None, None)

    store = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=query)))
    sources = [{'episode_id': stable_uuid('group', 'episode', 'capture')}]
    matches = await drafts_for_sources(store, {'id': 'space', 'group_id': 'group'}, sources)
    assert [row['draft']['id'] for row in matches] == sorted(states)
    at = datetime(2026, 10, 23, tzinfo=timezone.utc)
    counts = await scrub_publication_drafts(store, {'id': 'space'}, matches, 'deletion', at)
    assert counts == dict.fromkeys(states, 1)
    assert saved['pending']['status'] == 'source_deleted'
    assert saved['submitted']['status'] == 'submitted'
    assert saved['submitted']['shared_proposal_id'] == 'proposal'
    for state in states:
        assert saved[state]['payload'] is None
        assert text not in repr(saved[state])
        assert saved[state]['payload_scrubbed_by'] == 'deletion'
    assert text in saved['unrelated']['payload']
    # The submitted provenance remains discoverable after its body is gone.
    after = await drafts_for_sources(store, {'id': 'space', 'group_id': 'group'}, sources)
    assert {row['draft']['id'] for row in after} == set(states)


@pytest.mark.asyncio
async def test_turn_identity_requires_all_three_fields_and_never_matches_words():
    drafts = [dict(id='match', status='submitted', payload=json.dumps(dict(
        session_id='session', source_application='codex', source_turn_id='turn'))),
        dict(id='wrong-client', status='pending', payload=json.dumps(dict(
            session_id='session', source_application='claude', source_turn_id='turn'))),
        dict(id='missing-turn', status='pending', payload=json.dumps(dict(
            session_id='session', source_application='codex')))]

    async def query(cypher, **params):
        return ([{'draft': row, 'project_name': None} for row in drafts], None, None)

    store = SimpleNamespace(runtime=SimpleNamespace(driver=SimpleNamespace(execute_query=query)))
    matches = await drafts_for_sources(store, {'id': 'space', 'group_id': 'group'}, [dict(
        episode_id='episode', session_id='session', source_application='codex', source_turn_id='turn')])
    assert [row['draft']['id'] for row in matches] == ['match']
