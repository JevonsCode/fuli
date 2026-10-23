"""Integrity regression through the production HTTP boundary; synthetic IDs only."""
import pytest

from test_knowledge_hard_delete_http import REVIEW_TOKEN, application, call

REVIEW = {'x-fuli-human-review-token': REVIEW_TOKEN}


class IntegrityDriver:
    def __init__(self, audited):
        self.audited = audited
        self.queries = []

    async def execute_query(self, query, **params):
        self.queries.append(query)
        if 'RETURN ref.kind AS kind' in query:
            return ([{'kind': ref['kind'], 'id': ref['id'], 'present': False,
                      'deletion_ids': ['synthetic-deletion'] if self.audited else []}
                     for ref in params['references']], None, None)
        raise AssertionError(query)


@pytest.mark.asyncio
@pytest.mark.parametrize('audited', [True, False])
@pytest.mark.parametrize('kind', ['entity', 'session'])
async def test_integrity_distinguishes_300_audited_deletes_from_unexplained_loss(audited, kind):
    driver = IntegrityDriver(audited)
    app = application(driver)

    async def authorize(actor, space_id, role):
        return {'id': space_id, 'group_id': 'synthetic-group', 'kind': 'personal'}

    app.state.store.authorize = authorize
    response = await call(app, '/v1/knowledge/integrity', {
        'personal_space_id': 'space',
        'references': [{'kind': kind, 'id': f'item-{n}'} for n in range(300)]}, REVIEW)
    assert response.status_code == 200, response.text
    report = response.json()
    assert report['status'] == ('healthy' if audited else 'attention_required')
    assert report['expected_count'] == 300
    assert report['hard_deleted_count'] == (300 if audited else 0)
    assert report['missing_count'] == (0 if audited else 300)
    assert len(report['missing']) == report['missing_count']
    assert all('DELETE ' not in query and 'SET ' not in query and 'CREATE ' not in query
               for query in driver.queries)


@pytest.mark.asyncio
async def test_integrity_requires_human_review_before_reading():
    driver = IntegrityDriver(True)
    response = await call(application(driver), '/v1/knowledge/integrity',
                          {'personal_space_id': 'space', 'references': []}, {})
    assert response.status_code == 403
    assert driver.queries == []

@pytest.mark.asyncio
async def test_integrity_deduplicates_inventory_and_flags_resurrected_tombstones():
    class MixedDriver:
        async def execute_query(self, query, **params):
            assert len(params['references']) == 3
            assert params['group_id'] == 'synthetic-group'
            assert params['space_id'] == 'space'
            return ([
                {'kind': 'entity', 'id': 'present', 'present': True, 'deletion_ids': []},
                {'kind': 'episode', 'id': 'deleted', 'present': False, 'deletion_ids': ['d']},
                {'kind': 'relationship', 'id': 'resurrected', 'present': True, 'deletion_ids': ['d']},
            ], None, None)

    app = application(MixedDriver())

    async def authorize(actor, space_id, role):
        return {'id': space_id, 'group_id': 'synthetic-group', 'kind': 'personal'}

    app.state.store.authorize = authorize
    response = await call(app, '/v1/knowledge/integrity', {'personal_space_id': 'space', 'references': [
        {'kind': 'entity', 'id': 'present'}, {'kind': 'entity', 'id': 'present'},
        {'kind': 'episode', 'id': 'deleted'}, {'kind': 'relationship', 'id': 'resurrected'}]}, REVIEW)
    assert response.status_code == 200
    assert response.json() == {
        'status': 'attention_required', 'expected_count': 3, 'present_count': 1,
        'hard_deleted_count': 2, 'missing_count': 0, 'missing': [],
        'resurrected': [{'kind': 'relationship', 'id': 'resurrected'}], 'deletion_ids': ['d']}
