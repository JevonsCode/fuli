"""The preference organising read (rec#121): a page of the person's current
preferences and, on the first page, the copies the duplicate pair rules call
one, compared within one aspect and one scope (a relationship also within one
relation type and the same endpoints), proposed and never merged. Synthetic
preferences and a scripted driver; needs no graph."""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from fuli_graph.preference_organizing import PreferenceOrganizingRead, read_preference_organizing

T0 = datetime(2026, 11, 1, tzinfo=timezone.utc)
SAME_WORDS = ('Reply tone', 'Answer in short plain sentences.')


def preference(item_id, name, summary=None, *, aspect='taste', scope='global', project=None, status='pending',
               minutes=0, fact=None):
    item = {'item_id': item_id, 'name': name, 'summary': summary, 'fact': fact,
            'created_at': T0 + timedelta(minutes=minutes), 'confirmation_status': status, 'blocked': False,
            'scope': ['', [], '', ''], 'said_at': None}
    return {'item': item, 'aspect': aspect, 'scope': scope, 'project_id': project, 'project_ids': [], 'agent_id': None}


def relationship(item_id, fact, *, relation='PREFERS', source='person', target='layout', current=True, minutes=0):
    return {**preference(item_id, relation, fact=fact, minutes=minutes), 'current': current, 'relation': relation,
            'source_id': source, 'target_id': target}


class ScanDriver:
    """Answers each scan with its kind's rows, as the graph would after its
    visibility rule; the revision and meaning reads of the duplicate rules
    find nothing stored."""

    def __init__(self, entities, relationships=()):
        self.rows = {'(item:Entity': list(entities), '-[item:RELATES_TO': list(relationships)}
        self.scans = []

    async def execute_query(self, query, **parameters):
        if query.startswith('// preference organising: scan'):
            self.scans.append((query, parameters['reader']))
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


def grouped(page):
    return {(group.item_kind, group.keep): sorted((copy.item_id, copy.rule) for copy in group.same)
            for group in page.duplicates}


async def test_copies_of_one_preference_in_one_scope_are_proposed_as_one_group_and_never_across_scopes():
    driver = ScanDriver([
        preference('p1', *SAME_WORDS, status='confirmed'),
        preference('p2', *SAME_WORDS, minutes=5),
        preference('p3', 'reply tone', 'answer in  short plain sentences', minutes=9),
        # The same words in a project, or as another aspect, are not a copy here.
        preference('p4', *SAME_WORDS, scope='project', project='alpha'),
        preference('p5', *SAME_WORDS, aspect='personality'),
        preference('p6', 'Commit size', 'Keep each commit to one task.', scope='project', project='alpha'),
    ])
    page = await read(driver)
    assert grouped(page) == {('entity', 'p1'): [('p2', 'same_text'), ('p3', 'same_text')]}
    assert page.duplicates_truncated is False
    # An Agent reads: another FLA's own preferences are hidden by each scan's reader.
    assert [reader for _, reader in driver.scans] == [{'personal_project_id': None, 'project_agent_id': None}] * 2


async def test_relationship_copies_need_one_relation_type_and_the_same_endpoints():
    fact = 'Prefers light page layouts.'
    page = await read(ScanDriver([], [
        relationship('r1', fact, minutes=1), relationship('r2', fact, minutes=2),
        relationship('r3', fact, relation='AVOIDS', minutes=3),
        relationship('r4', fact, target='dashboard', minutes=4),
        # A retired one is no copy, and not listed.
        relationship('r5', fact, current=False, minutes=5)]))
    assert grouped(page) == {('relationship', 'r1'): [('r2', 'same_text')]}
    assert sorted(item.item_id for item in page.preferences) == ['r1', 'r2', 'r3', 'r4']


async def test_an_entity_a_visible_preference_relationship_hangs_on_is_its_subject_even_when_retired():
    driver = ScanDriver([
        preference('subject-current', 'Page layout'),
        preference('subject-retired', 'Dashboard'),
        # Its only preference relationship belongs to another FLA: the scan does not return it.
        preference('own', 'Reply tone', 'Answer in short plain sentences.'),
    ], [relationship('r1', 'Prefers light page layouts.', target='subject-current'),
        relationship('r2', 'Prefers dense dashboards.', target='subject-retired', current=False)])
    page = await read(driver)
    assert sorted(item.item_id for item in page.preferences) == ['own', 'r1']
    # The graph decides what this reader sees, and retired relationships are read for their endpoints.
    relationship_scan = next(query for query, _ in driver.scans if '-[item:RELATES_TO' in query)
    assert '$reader' in relationship_scan and 'item.invalid_at IS NULL AS current' in relationship_scan
    assert 'WHERE item.invalid_at IS NULL' not in relationship_scan


async def test_the_page_lists_global_first_with_status_and_only_the_first_page_carries_duplicates():
    driver = ScanDriver([
        preference('a', 'Commit size', 'Keep each commit to one task.', scope='project', project='alpha'),
        preference('b', *SAME_WORDS, status='confirmed'),
        preference('b2', *SAME_WORDS, minutes=1),
        preference('c', 'Naming', 'Name functions by what they mean.', aspect='judgment_preference',
                   status='agent_confirmed'),
    ])
    first = await read(driver, limit=3)
    assert [first.total, first.pending, first.next_offset] == [4, 2, 3]
    assert [(item.item_id, item.scope, item.project_id, item.status) for item in first.preferences] == [
        ('c', 'global', None, 'agent_confirmed'), ('b', 'global', None, 'confirmed'), ('b2', 'global', None, 'pending')]
    assert first.preferences[1].text == 'Reply tone\nAnswer in short plain sentences.'
    assert grouped(first) == {('entity', 'b'): [('b2', 'same_text')]}
    rest = await read(driver, offset=3, limit=3)
    assert [item.item_id for item in rest.preferences] == ['a'] and rest.next_offset is None
    assert rest.duplicates is None and rest.duplicates_truncated is None


async def test_a_long_preference_is_cut_and_a_team_space_is_refused():
    page = await read(ScanDriver([preference('long', 'Style', 'x' * 400)]))
    assert len(page.preferences[0].text) == 300 and page.preferences[0].text.endswith('…')
    with pytest.raises(HTTPException) as refused:
        await read_preference_organizing(Store(ScanDriver([]), kind='team'), {},
                                         PreferenceOrganizingRead(personal_space_id='space-synthetic'))
    assert refused.value.status_code == 422


def test_the_provider_serves_the_read_as_a_post_query_without_empty_fields(monkeypatch):
    monkeypatch.setenv('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
    monkeypatch.setenv('FULI_NEO4J_PASSWORD', 'test-password')
    from fuli_graph.app import create_app
    from fuli_graph.config import Settings
    application = create_app(Settings(bootstrap_token='test-bootstrap-token-1234', neo4j_password='test-password'))
    assert set(application.openapi()['paths']['/v1/knowledge/preferences/organizing']) == {'post'}
    [route] = [route for route in application.routes if getattr(route, 'path', '') == '/v1/knowledge/preferences/organizing']
    assert route.response_model_exclude_none is True
