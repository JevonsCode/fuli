"""The preference organising read (rec#121): a page of the person's current
preferences and the copies the duplicate pair rules call one, compared within
one aspect and one scope, proposed and never merged. Synthetic preferences
and a scripted driver; needs no graph."""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from fuli_graph.preference_organizing import PreferenceOrganizingRead, read_preference_organizing

T0 = datetime(2026, 11, 1, tzinfo=timezone.utc)


def preference(item_id, name, summary=None, *, aspect='taste', scope='global', project=None, status='pending',
               minutes=0, fact=None):
    item = {'item_id': item_id, 'name': name, 'summary': summary, 'fact': fact,
            'created_at': T0 + timedelta(minutes=minutes), 'confirmation_status': status, 'blocked': False,
            'scope': ['', [], '', ''], 'said_at': None}
    return {'item': item, 'aspect': aspect, 'scope': scope, 'project_id': project, 'project_ids': [], 'agent_id': None}


class ScanDriver:
    """Answers each scan with its kind's rows; the revision and meaning reads
    of the duplicate rules find nothing stored."""

    def __init__(self, entities, relationships=()):
        self.rows = {'(item:Entity': list(entities), '-[item:RELATES_TO': list(relationships)}
        self.readers = []

    async def execute_query(self, query, **parameters):
        if query.startswith('// preference organising: scan'):
            self.readers.append(parameters['reader'])
            return next(rows for marker, rows in self.rows.items() if marker in query), None, None
        return [], None, None


class Store:
    def __init__(self, driver, kind='personal'):
        self.runtime = type('Runtime', (), {'driver': driver})()
        self.kind = kind

    def _require_personal(self):
        return None

    async def authorize(self, actor, space_id, role):
        assert role == 'reader'
        return {'id': space_id, 'group_id': 'group-synthetic', 'kind': self.kind}


async def read(driver, **request):
    return await read_preference_organizing(Store(driver), {'subject': 'synthetic-agent'},
                                            PreferenceOrganizingRead(personal_space_id='space-synthetic', **request))


async def test_copies_of_one_preference_in_one_scope_are_proposed_as_one_group_and_never_across_scopes():
    driver = ScanDriver([
        preference('p1', 'Reply tone', 'Answer in short plain sentences.', status='confirmed'),
        preference('p2', 'Reply tone', 'Answer in short plain sentences.', minutes=5),
        preference('p3', 'reply tone', 'answer in  short plain sentences', minutes=9),
        # The same words in a project, or as another aspect, are not a copy here.
        preference('p4', 'Reply tone', 'Answer in short plain sentences.', scope='project', project='alpha'),
        preference('p5', 'Reply tone', 'Answer in short plain sentences.', aspect='personality'),
        preference('p6', 'Commit size', 'Keep each commit to one task.', scope='project', project='alpha'),
    ], [preference('r1', None, fact='Prefers light page layouts.', minutes=1),
        preference('r2', None, fact='Prefers light page layouts.', minutes=2)])
    page = await read(driver)

    groups = {(group.item_kind, group.keep): sorted((copy.item_id, copy.rule) for copy in group.same)
              for group in page.duplicates}
    assert groups == {('entity', 'p1'): [('p2', 'same_text'), ('p3', 'same_text')],
                      ('relationship', 'r1'): [('r2', 'same_text')]}
    assert page.duplicates_truncated is False
    # An Agent reads: another FLA's own preferences are hidden by the scan's reader.
    assert driver.readers == [{'personal_project_id': None, 'project_agent_id': None}] * 2


async def test_the_page_lists_global_first_with_status_and_counts_pending():
    driver = ScanDriver([
        preference('a', 'Commit size', 'Keep each commit to one task.', scope='project', project='alpha'),
        preference('b', 'Reply tone', 'Answer in short plain sentences.', status='confirmed'),
        preference('c', 'Naming', 'Name functions by what they mean.', aspect='judgment_preference',
                   status='agent_confirmed'),
    ])
    first = await read(driver, limit=2)
    assert [first.total, first.pending, first.next_offset] == [3, 1, 2]
    assert [(item.item_id, item.scope, item.project_id, item.status) for item in first.preferences] == [
        ('c', 'global', None, 'agent_confirmed'), ('b', 'global', None, 'confirmed')]
    assert first.preferences[1].text == 'Reply tone\nAnswer in short plain sentences.'
    rest = await read(driver, offset=2, limit=2)
    assert [item.item_id for item in rest.preferences] == ['a'] and rest.next_offset is None


async def test_a_long_preference_is_cut_and_a_team_space_is_refused():
    page = await read(ScanDriver([preference('long', 'Style', 'x' * 400)]))
    assert len(page.preferences[0].text) == 300 and page.preferences[0].text.endswith('…')
    with pytest.raises(HTTPException) as refused:
        await read_preference_organizing(Store(ScanDriver([]), kind='team'), {},
                                         PreferenceOrganizingRead(personal_space_id='space-synthetic'))
    assert refused.value.status_code == 422


def test_the_provider_serves_the_read_as_a_post_query(monkeypatch):
    monkeypatch.setenv('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
    monkeypatch.setenv('FULI_NEO4J_PASSWORD', 'test-password')
    from fuli_graph.app import create_app
    from fuli_graph.config import Settings
    application = create_app(Settings(bootstrap_token='test-bootstrap-token-1234', neo4j_password='test-password'))
    assert set(application.openapi()['paths']['/v1/knowledge/preferences/organizing']) == {'post'}
