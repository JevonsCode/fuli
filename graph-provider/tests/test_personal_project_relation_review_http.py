import os
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest

os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'test-password')

from fuli_graph.app import create_app
from fuli_graph.collaboration_context import _project_scopes
from fuli_graph.config import Settings
from fuli_graph.project_action_models import KnowledgeProjectActionRequest
from fuli_graph.project_knowledge import _maybe_create_project_relation


HUMAN_REVIEW_TOKEN = 'test-relation-human-review-token'


@pytest.mark.asyncio
async def test_project_action_relation_is_pending_until_independent_human_review():
    driver = RelationReviewDriver()
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        human_review_token=HUMAN_REVIEW_TOKEN,
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)
    store.authenticate = async_value({'id': 'principal-1'})
    store.authorize = async_value({
        'id': 'personal-space',
        'kind': 'personal',
        'group_id': 'personal-group',
    })
    request = KnowledgeProjectActionRequest(
        personal_space_id='personal-space',
        mode='existing',
        target_project_id='platform-a',
        keep_source_relation=True,
        relation_type='PART_OF',
        reason='Agent proposes that travel-d is part of platform-a.',
        operation_actor='human',
    )

    created = await _maybe_create_project_relation(
        store,
        {
            'id': 'personal-space',
            'kind': 'personal',
            'group_id': 'personal-group',
        },
        'travel-d',
        'platform-a',
        request,
        'ordinary-agent-principal',
    )

    assert created is True
    assert driver.relation['status'] == 'pending'
    assert driver.relation['confirmation_authority'] is None
    assert await _project_scopes(
        store,
        {'id': 'personal-space'},
        'travel-d',
    ) == {
        'travel-d': {
            'scope_distance': 0,
            'scope_path': ['travel-d'],
        },
    }

    relation_id = driver.relation['id']
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={'authorization': 'Bearer test-access-token'},
    ) as client:
        forged = await client.post(
            f'/v1/personal-spaces/personal-space/project-relations/{relation_id}/review',
            json={
                'decision': 'activate',
                'decision_revision': 0,
                'reason': '请求体声称已人工确认，但没有独立证明。',
            },
        )
        assert forged.status_code == 403, forged.text
        assert driver.relation['status'] == 'pending'

        activated = await client.post(
            f'/v1/personal-spaces/personal-space/project-relations/{relation_id}/review',
            json={
                'decision': 'activate',
                'decision_revision': 0,
                'reason': '用户通过独立本地审查确认这条继承关系。',
            },
            headers={'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN},
        )
        assert activated.status_code == 200, activated.text
        assert activated.json()['status'] == 'active'
        assert activated.json()['confirmation_authority'] == 'human_review'
        assert activated.json()['decision_revision'] == 1

        stale = await client.post(
            f'/v1/personal-spaces/personal-space/project-relations/{relation_id}/review',
            json={
                'decision': 'reject',
                'decision_revision': 0,
                'reason': '过期的相反决定。',
            },
            headers={'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN},
        )
        assert stale.status_code == 409, stale.text

    assert await _project_scopes(
        store,
        {'id': 'personal-space'},
        'travel-d',
    ) == {
        'travel-d': {
            'scope_distance': 0,
            'scope_path': ['travel-d'],
        },
        'platform-a': {
            'scope_distance': 1,
            'scope_path': ['travel-d', 'platform-a'],
        },
    }
    assert driver.review_events == [{
        'decision_revision': 1,
        'status': 'active',
        'confirmation_authority': 'human_review',
    }]
    assert all(
        "relation.status = 'active'" in query
        and "relation.confirmation_authority = 'human_review'" in query
        for query in driver.traversal_queries
    )


class RelationReviewDriver:
    def __init__(self):
        self.relation = None
        self.review_events = []
        self.traversal_queries = []

    async def execute_query(self, query, **parameters):
        if 'MERGE (source)-[relation:PERSONAL_PROJECT_RELATION' in query:
            assert "relation.status = 'pending'" in query
            assert 'operation_actor' not in parameters
            self.relation = {
                'id': parameters['relation_id'],
                'source_project_id': parameters['source_project_id'],
                'target_project_id': parameters['target_project_id'],
                'relation_type': parameters['relation_type'],
                'status': 'pending',
                'confirmation_authority': None,
                'decision_revision': 0,
            }
            return [{'id': parameters['relation_id']}], None, None
        if 'fuli:review-personal-project-relation' in query:
            relation = self.relation
            if (
                relation is None
                or relation['id'] != parameters['relation_id']
                or relation['decision_revision'] != parameters['expected_revision']
            ):
                return [], None, None
            relation.update({
                'status': parameters['status'],
                'confirmation_authority': parameters['confirmation_authority'],
                'decision_revision': parameters['next_revision'],
                'reviewed_by': parameters['reviewed_by'],
                'reviewed_at': parameters['reviewed_at'],
                'review_reason': parameters['review_reason'],
            })
            self.review_events.append({
                'decision_revision': parameters['next_revision'],
                'status': parameters['status'],
                'confirmation_authority': parameters['confirmation_authority'],
            })
            return [{
                'relation_id': relation['id'],
                'source_project_id': relation['source_project_id'],
                'target_project_id': relation['target_project_id'],
                'relation_type': relation['relation_type'],
                'status': relation['status'],
                'confirmation_authority': relation['confirmation_authority'],
                'decision_revision': relation['decision_revision'],
                'reviewed_by': relation['reviewed_by'],
                'reviewed_at': relation['reviewed_at'],
                'review_reason': relation['review_reason'],
                'review_event_id': parameters['review_event_id'],
            }], None, None
        if 'MATCH path=(active)-[:PERSONAL_PROJECT_RELATION*1..2]->' in query:
            self.traversal_queries.append(query)
            if (
                self.relation
                and self.relation['status'] == 'active'
                and self.relation['confirmation_authority'] == 'human_review'
            ):
                return [{
                    'project_id': self.relation['target_project_id'],
                    'scope_path': [
                        self.relation['source_project_id'],
                        self.relation['target_project_id'],
                    ],
                    'scope_distance': 1,
                }], None, None
            return [], None, None
        raise AssertionError(f'Unexpected query: {query[:120]}')


def async_value(value):
    async def resolve(*_args, **_kwargs):
        return value

    return resolve
