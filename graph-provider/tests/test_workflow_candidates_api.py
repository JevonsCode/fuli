import os
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest

os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
os.environ.setdefault(
    'FULI_WORKFLOW_OBSERVATION_TOKEN',
    'test-workflow-observation-token-for-mcp-host-only',
)
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'test-password')

from fuli_graph.app import create_app
from fuli_graph.config import Settings
from workflow_candidate_test_support import WorkflowCommitDriver

WORKFLOW_OBSERVATION_TOKEN = (
    'test-workflow-observation-token-for-mcp-host-only'
)
RECENT_OBSERVED_AT = datetime.now(UTC).replace(microsecond=0)


@pytest.mark.asyncio
async def test_recommendation_explains_three_observations_without_authorizing_execution():
    observed_at = RECENT_OBSERVED_AT
    driver = SequentialDriver([[
        {
            'candidate_id': 'workflow-candidate-1',
            'personal_space_id': 'personal-space',
            'personal_project_id': 'travel-d',
            'source_step_id': 'step-x-id',
            'source_step_key': 'step-x',
            'source_step_name': 'Generate release notes',
            'target_step_id': 'step-y-id',
            'target_step_key': 'step-y',
            'target_step_name': 'Check links',
            'status': 'pending',
            'occurrence_count': 3,
            'distinct_session_count': 3,
            'first_observed_at': observed_at,
            'last_observed_at': observed_at,
            'confirmation_authority': 'agent_proposed',
            'negative_evidence_count': 0,
            'decline_count': 0,
            'reviewed_at': None,
            'review_reason': None,
            'authorization_id': None,
            'authorization_active': False,
            'authorization_authority': None,
            'authorization_created_at': None,
        }
    ]])
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)

    async def authenticate(token):
        assert token == 'test-access-token'
        return {'id': 'principal-1'}

    async def authorize(actor, space_id, role):
        assert actor == {'id': 'principal-1'}
        assert (space_id, role) == ('personal-space', 'reader')
        return {
            'id': 'personal-space',
            'kind': 'personal',
            'group_id': 'personal-group',
        }

    store.authenticate = authenticate
    store.authorize = authorize

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
    ) as client:
        response = await client.post(
            '/v1/workflow-candidates/search',
            json={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
                'after_step_key': 'step-x',
            },
            headers={'authorization': 'Bearer test-access-token'},
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body['policy'] == {
        'minimum_occurrences': 3,
        'minimum_distinct_sessions': 3,
        'recommendation_threshold': 0.7,
        'weights': {
            'occurrences': 0.45,
            'distinct_sessions': 0.25,
            'recency': 0.2,
            'confirmation_authority': 0.1,
        },
        'decline_penalty': 0.25,
        'negative_evidence_penalty': 0.1,
    }
    assert body['candidates'] == [{
        **body['candidates'][0],
        'candidate_id': 'workflow-candidate-1',
        'status': 'pending',
        'occurrence_count': 3,
        'distinct_session_count': 3,
        'confirmation_authority': 'agent_proposed',
        'negative_evidence_count': 0,
        'decline_count': 0,
        'recommendation': {
            'recommended': True,
            'score': 0.9,
            'threshold': 0.7,
            'action': 'ask_user',
        },
        'execution_authorized': False,
        'authorization': None,
    }]


@pytest.mark.asyncio
async def test_three_session_commits_materialize_one_persistent_workflow_candidate():
    driver = WorkflowCommitDriver()
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver, embedder=ZeroEmbedder())

    async def authenticate(_token):
        return {'id': 'principal-1'}

    async def authorize(_actor, space_id, role):
        assert (space_id, role) in {
            ('personal-space', 'maintainer'),
            ('personal-space', 'reader'),
        }
        return {
            'id': 'personal-space',
            'kind': 'personal',
            'group_id': 'personal-group',
        }

    store.authenticate = authenticate
    store.authorize = authorize

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers=host_observation_headers(),
    ) as client:
        for occurrence in range(3):
            response = await client.post(
                '/v1/workflow-observations',
                json=workflow_observation_input(occurrence),
            )
            assert response.status_code == 200, response.text
        response = await client.post(
            '/v1/workflow-candidates/search',
            json={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
                'after_step_key': 'step-x',
            },
        )

    assert response.status_code == 200, response.text
    candidate = response.json()['candidates'][0]
    assert candidate['occurrence_count'] == 3
    assert candidate['distinct_session_count'] == 3
    assert candidate['status'] == 'pending'
    assert candidate['candidate_version'] == 1
    assert candidate['execution_authorized'] is False
    assert driver.materialized_occurrence_counts == [3]


@pytest.mark.asyncio
async def test_host_observation_endpoint_accepts_one_event_not_counts_or_authority():
    driver = WorkflowCommitDriver()
    application = workflow_application(driver)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={'authorization': 'Bearer test-access-token'},
    ) as client:
        actor_only = await client.post(
            '/v1/workflow-observations',
            json=workflow_observation_input(0),
        )
        wrong_host = await client.post(
            '/v1/workflow-observations',
            json=workflow_observation_input(0),
            headers={'x-fuli-workflow-observation-token': 'wrong-host-proof'},
        )
        for occurrence in range(3):
            observed = await client.post(
                '/v1/workflow-observations',
                json=workflow_observation_input(occurrence),
                headers={
                    'x-fuli-workflow-observation-token': (
                        WORKFLOW_OBSERVATION_TOKEN
                    ),
                },
            )
            assert observed.status_code == 200, observed.text
        forged_aggregate = await client.post(
            '/v1/workflow-observations',
            json={
                **workflow_observation_input(3),
                'occurrence_count': 99,
                'authority': 'user',
            },
            headers={
                'x-fuli-workflow-observation-token': (
                    WORKFLOW_OBSERVATION_TOKEN
                ),
            },
        )
        recommended = await client.post(
            '/v1/workflow-candidates/search',
            json={'personal_space_id': 'personal-space'},
        )

    assert actor_only.status_code == 403
    assert wrong_host.status_code == 403
    assert forged_aggregate.status_code == 422
    assert driver.workflow_session_authorities == ['mcp_host'] * 3
    candidate = recommended.json()['candidates'][0]
    assert candidate['occurrence_count'] == 3
    assert candidate['distinct_session_count'] == 3
    assert candidate['execution_authorized'] is False


@pytest.mark.asyncio
async def test_generic_edges_cannot_contaminate_host_candidate_provenance():
    driver = WorkflowCommitDriver()
    application = workflow_application(driver)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers=host_observation_headers(),
    ) as client:
        generic_relationship_ids = []
        for occurrence in range(3):
            generic = await client.post(
                '/v1/knowledge/commits',
                json=workflow_episode(occurrence),
            )
            assert generic.status_code == 200, generic.text
            generic_relationship_ids.extend(
                generic.json()['relationship_ids']
            )
        for relationship_id in generic_relationship_ids:
            edge = driver.edges[relationship_id]
            edge['workflow_confirmation_authority'] = 'user'
            edge['negative_evidence_count'] = 7
        generic_only = await client.post(
            '/v1/workflow-candidates/search',
            json={'personal_space_id': 'personal-space'},
        )

        trusted_relationship_ids = []
        for occurrence in range(3, 6):
            trusted = await client.post(
                '/v1/workflow-observations',
                json=workflow_observation_input(occurrence),
            )
            assert trusted.status_code == 200, trusted.text
            trusted_relationship_ids.extend(
                trusted.json()['relationship_ids']
            )
        listed = await client.post(
            '/v1/workflow-candidates/search',
            json={'personal_space_id': 'personal-space'},
        )

    assert generic_only.json()['candidates'] == []
    candidate = listed.json()['candidates'][0]
    assert candidate['confirmation_authority'] == 'agent_proposed'
    assert candidate['negative_evidence_count'] == 0
    assert set(driver.candidate['evidence_ids']) == set(
        trusted_relationship_ids
    )
    assert set(driver.candidate['evidence_ids']).isdisjoint(
        generic_relationship_ids
    )


@pytest.mark.asyncio
async def test_three_sessions_on_one_merged_edge_count_as_three_occurrences():
    driver = WorkflowCommitDriver()
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver, embedder=ZeroEmbedder())
    store.authenticate = async_result({'id': 'principal-1'})
    store.authorize = async_result({
        'id': 'personal-space',
        'kind': 'personal',
        'group_id': 'personal-group',
    })

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers=host_observation_headers(),
    ) as client:
        for occurrence in range(3):
            response = await client.post(
                '/v1/workflow-observations',
                json=workflow_observation_input(
                    occurrence,
                    observed_at='2026-08-03T08:00:00Z',
                ),
            )
            assert response.status_code == 200, response.text
        response = await client.post(
            '/v1/workflow-candidates/search',
            json={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
                'after_step_key': 'step-x',
            },
        )

    assert response.status_code == 200, response.text
    assert len(driver.edges) == 1
    assert len(next(iter(driver.edges.values()))['episodes']) == 3
    assert response.json()['candidates'][0]['occurrence_count'] == 3


@pytest.mark.asyncio
async def test_three_occurrences_in_one_session_form_a_candidate_but_not_a_recommendation():
    driver = WorkflowCommitDriver()
    application = workflow_application(driver)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers=host_observation_headers(),
    ) as client:
        for occurrence in range(3):
            committed = await client.post(
                '/v1/workflow-observations',
                json=workflow_observation_input(
                    occurrence,
                    host_session_id='one-session',
                ),
            )
            assert committed.status_code == 200, committed.text
        listed = await client.post(
            '/v1/workflow-candidates/search',
            json={'personal_space_id': 'personal-space'},
        )

    candidate = listed.json()['candidates'][0]
    assert candidate['occurrence_count'] == 3
    assert candidate['distinct_session_count'] == 1
    assert candidate['recommendation']['score'] > 0.7
    assert candidate['recommendation']['recommended'] is False
    assert candidate['recommendation']['action'] == 'none'
    assert listed.json()['policy']['minimum_distinct_sessions'] == 3


@pytest.mark.asyncio
async def test_rule_changes_bump_version_while_new_evidence_bumps_evidence_revision():
    driver = WorkflowCommitDriver()
    application = workflow_application(driver)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers=host_observation_headers(),
    ) as client:
        for occurrence in range(3):
            committed = await client.post(
                '/v1/workflow-observations',
                json=workflow_observation_input(
                    occurrence,
                    condition={'releaseChannel': 'draft'},
                ),
            )
            assert committed.status_code == 200, committed.text
        first = await client.post(
            '/v1/workflow-candidates/search',
            json={'personal_space_id': 'personal-space'},
        )

        fourth = await client.post(
            '/v1/workflow-observations',
            json=workflow_observation_input(
                3,
                condition={'releaseChannel': 'draft'},
            ),
        )
        assert fourth.status_code == 200, fourth.text
        evidence_changed = await client.post(
            '/v1/workflow-candidates/search',
            json={'personal_space_id': 'personal-space'},
        )

        for occurrence in range(4, 7):
            committed = await client.post(
                '/v1/workflow-observations',
                json=workflow_observation_input(
                    occurrence,
                    condition={'releaseChannel': 'final'},
                ),
            )
            assert committed.status_code == 200, committed.text
        rule_changed = await client.post(
            '/v1/workflow-candidates/search',
            json={'personal_space_id': 'personal-space'},
        )

    first_candidate = first.json()['candidates'][0]
    evidence_candidate = evidence_changed.json()['candidates'][0]
    rule_candidate = rule_changed.json()['candidates'][0]
    assert first_candidate['candidate_version'] == 1
    assert first_candidate['evidence_revision'] == 1
    assert evidence_candidate['candidate_id'] == first_candidate['candidate_id']
    assert evidence_candidate['candidate_version'] == 1
    assert evidence_candidate['evidence_revision'] == 2
    assert rule_candidate['candidate_id'] == first_candidate['candidate_id']
    assert rule_candidate['candidate_version'] == 2
    assert rule_candidate['evidence_revision'] == 3
    assert rule_candidate['status'] == 'pending'


@pytest.mark.asyncio
async def test_distinct_workflow_keys_keep_parallel_conditions_as_separate_candidates():
    driver = WorkflowCommitDriver()
    application = workflow_application(driver)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers=host_observation_headers(),
    ) as client:
        for occurrence in range(3):
            draft = await client.post(
                '/v1/workflow-observations',
                json=workflow_observation_input(
                    occurrence,
                    condition={'releaseChannel': 'draft'},
                    workflow_key='draft-release-link-check',
                ),
            )
            assert draft.status_code == 200, draft.text
        for occurrence in range(3, 6):
            final = await client.post(
                '/v1/workflow-observations',
                json=workflow_observation_input(
                    occurrence,
                    condition={'releaseChannel': 'final'},
                    workflow_key='final-release-link-check',
                ),
            )
            assert final.status_code == 200, final.text
        listed = await client.post(
            '/v1/workflow-candidates/search',
            json={'personal_space_id': 'personal-space'},
        )

    assert listed.status_code == 200, listed.text
    candidates = listed.json()['candidates']
    assert len(candidates) == 2
    assert {candidate['workflow_key'] for candidate in candidates} == {
        'draft-release-link-check',
        'final-release-link-check',
    }
    assert {candidate['candidate_version'] for candidate in candidates} == {1}


def workflow_application(driver):
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver, embedder=ZeroEmbedder())
    store.authenticate = async_result({'id': 'principal-1'})
    store.authorize = async_result({
        'id': 'personal-space',
        'kind': 'personal',
        'group_id': 'personal-group',
    })
    return application


def workflow_episode(
    occurrence,
    *,
    observed_at=None,
    condition=None,
    relationship_key='step-x-recommends-step-y',
    session_id=None,
):
    observed_at = observed_at or (
        RECENT_OBSERVED_AT - timedelta(days=occurrence)
    ).isoformat().replace('+00:00', 'Z')
    basis = {
        'existence_reason': 'Observed in one bounded MOCK session.',
        'quadrant_reason': 'The step order is behavioral evidence, not consent.',
        'proposed_by': {'kind': 'agent', 'label': 'test-agent'},
    }
    return {
        'space_id': 'personal-space',
        'personal_project_id': 'travel-d',
        'episode': {
            'idempotency_key': f'workflow-observation-{occurrence}',
            'session_id': session_id or f'session-{occurrence}',
            'name': 'Observed X then Y',
            'source_kind': 'mock_test',
            'source_description': 'MOCK test evidence.',
            'source_application': 'codex',
            'reference_time': observed_at,
            'entities': [
                {
                    'key': 'step-x',
                    'name': 'Generate release notes',
                    'type': 'WorkflowStep',
                    'summary': 'Step X.',
                    'confirmation_status': 'pending',
                    'confirmation_basis': basis,
                },
                {
                    'key': 'step-y',
                    'name': 'Check links',
                    'type': 'WorkflowStep',
                    'summary': 'Step Y.',
                    'confirmation_status': 'pending',
                    'confirmation_basis': basis,
                },
            ],
            'relationships': [{
                'key': relationship_key,
                'source': 'step-x',
                'target': 'step-y',
                'type': 'RECOMMENDS_NEXT',
                'fact': 'Step X was followed by step Y.',
                'origin_quadrant': 'unknown_known',
                'confirmation_status': 'pending',
                'confirmation_basis': basis,
                'reasoning_summary': 'Inferred from behavior only.',
                'attributes': {'workflowCondition': condition or {}},
            }],
        },
    }


def host_observation_headers():
    return {
        'authorization': 'Bearer test-access-token',
        'x-fuli-workflow-observation-token': WORKFLOW_OBSERVATION_TOKEN,
    }


def workflow_observation_input(
    occurrence,
    *,
    condition=None,
    workflow_key='step-x-recommends-step-y',
    host_session_id=None,
    observed_at=None,
):
    return {
        'personal_space_id': 'personal-space',
        'personal_project_id': 'travel-d',
        'host_session_id': host_session_id or f'host-session-{occurrence}',
        'observation_id': (
            f'workflow-observation-endpoint-{workflow_key}-{occurrence}'
        ),
        'from_step': {
            'action_id': 'step-x',
            'name': 'Generate release notes',
        },
        'to_step': {
            'action_id': 'step-y',
            'name': 'Check links',
        },
        'workflow_key': workflow_key,
        'condition': condition or {},
        'observed_at': (
        observed_at or (
            RECENT_OBSERVED_AT - timedelta(days=occurrence)
        ).isoformat().replace('+00:00', 'Z')
        ),
        'evidence_summary': 'Step X completed and was followed by step Y.',
        'source_application': 'other',
    }


class SequentialDriver:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def execute_query(self, query, **parameters):
        self.calls.append((query, parameters))
        return self.responses.pop(0), None, None


class ZeroEmbedder:
    async def create_batch(self, values):
        return [[0.0] * 384 for _ in values]


def async_result(value):
    async def result(*_args, **_kwargs):
        return value
    return result
