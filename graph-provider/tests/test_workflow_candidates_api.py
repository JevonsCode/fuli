import os
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest

os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
os.environ.setdefault(
    'FULI_HUMAN_REVIEW_TOKEN',
    'test-human-review-token-not-shared-with-agents',
)
os.environ.setdefault(
    'FULI_WORKFLOW_OBSERVATION_TOKEN',
    'test-workflow-observation-token-for-mcp-host-only',
)
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'test-password')

from fuli_graph.app import create_app
from fuli_graph.config import Settings
from workflow_candidate_test_support import WorkflowCommitDriver

HUMAN_REVIEW_TOKEN = 'test-human-review-token-not-shared-with-agents'
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
            '/v1/workflow-candidates/recommendations',
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
            '/v1/workflow-candidates/recommendations',
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
            '/v1/workflow-candidates/recommendations',
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
            '/v1/workflow-candidates/recommendations',
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
        recommended = await client.post(
            '/v1/workflow-candidates/recommendations',
            json={'personal_space_id': 'personal-space'},
        )

    candidate = listed.json()['candidates'][0]
    assert candidate['occurrence_count'] == 3
    assert candidate['distinct_session_count'] == 1
    assert candidate['recommendation']['score'] > 0.7
    assert candidate['recommendation']['recommended'] is False
    assert candidate['recommendation']['action'] == 'none'
    assert listed.json()['policy']['minimum_distinct_sessions'] == 3
    assert recommended.json()['candidates'] == []


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


@pytest.mark.asyncio
async def test_human_rejection_keeps_history_and_lowers_future_recommendation():
    driver = WorkflowReviewDriver()
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver)

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
        headers={
            'authorization': 'Bearer test-access-token',
            'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN,
        },
    ) as client:
        intent = {
            'personal_space_id': 'personal-space',
            'candidate_version': 1,
            'evidence_revision': 1,
            'decision_revision': 0,
            'idempotency_key': 'reject-workflow-candidate-1',
            'decision': 'reject',
            'reason': 'Do not suggest link checks for this workflow.',
            'authority': {'kind': 'user', 'label': 'Workspace owner'},
            'decision_source': 'direct_user_confirmation',
            'durable_authorization_confirmed': False,
        }
        preview = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review-preview',
            json=intent,
        )
        assert preview.status_code == 200, preview.text
        rejected = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review',
            json={
                **intent,
                'approval_token': preview.json()['approval_token'],
            },
        )
        listed = await client.post(
            '/v1/workflow-candidates/search',
            json={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
            },
        )
        recommended = await client.post(
            '/v1/workflow-candidates/recommendations',
            json={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
                'after_step_key': 'step-x',
            },
        )

    assert rejected.status_code == 200, rejected.text
    assert listed.status_code == 200, listed.text
    candidate = listed.json()['candidates'][0]
    assert candidate['status'] == 'rejected'
    assert candidate['occurrence_count'] == 3
    assert candidate['decline_count'] == 1
    assert candidate['recommendation'] == {
        'recommended': False,
        'score': 0.65,
        'threshold': 0.7,
        'action': 'none',
    }
    assert candidate['execution_authorized'] is False
    assert recommended.json()['candidates'] == []
    assert driver.review_events == [{
        'decision': 'reject',
        'candidate_version': 1,
        'authority': 'user',
    }]


@pytest.mark.asyncio
async def test_approval_persists_version_bound_rule_without_approving_high_risk_calls():
    driver = WorkflowApprovalDriver()
    first_application = workflow_application(driver)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=first_application),
        base_url='http://provider.test',
        headers={
            'authorization': 'Bearer test-access-token',
            'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN,
        },
    ) as client:
        intent = {
            'personal_space_id': 'personal-space',
            'candidate_version': 1,
            'evidence_revision': 1,
            'decision_revision': 0,
            'idempotency_key': 'approve-workflow-candidate-1',
            'decision': 'approve',
            'reason': 'Always check links after generating release notes.',
            'authority': {'kind': 'user', 'label': 'Workspace owner'},
            'decision_source': 'direct_user_confirmation',
            'durable_authorization_confirmed': True,
        }
        preview = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review-preview',
            json=intent,
        )
        assert preview.status_code == 200, preview.text
        approved = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review',
            json={
                **intent,
                'approval_token': preview.json()['approval_token'],
            },
        )

    assert approved.status_code == 200, approved.text

    fresh_application = workflow_application(driver)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=fresh_application),
        base_url='http://provider.test',
        headers={'authorization': 'Bearer test-access-token'},
    ) as client:
        reread = await client.post(
            '/v1/workflow-candidates/search',
            json={
                'personal_space_id': 'personal-space',
                'personal_project_id': 'travel-d',
            },
        )

    assert reread.status_code == 200, reread.text
    candidate = reread.json()['candidates'][0]
    assert candidate['status'] == 'approved'
    assert candidate['candidate_version'] == 1
    assert candidate['execution_authorized'] is True
    assert candidate['authorization'] == {
        **candidate['authorization'],
        'candidate_id': 'workflow-candidate-1',
        'candidate_version': 1,
        'rule_fingerprint': 'rule-fingerprint-1',
        'scope': 'durable',
        'active': True,
        'authority': 'user',
        'high_risk_per_call_approval_required': True,
        'high_risk_action_categories': [
            'send', 'delete', 'publish', 'payment', 'external_write'
        ],
    }
    assert driver.authorizations[0]['candidate_version'] == 1
    assert driver.authorizations[0]['rule_fingerprint'] == 'rule-fingerprint-1'


@pytest.mark.asyncio
async def test_approval_without_a_human_preview_token_is_rejected():
    driver = WorkflowApprovalDriver()
    application = workflow_application(driver)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={
            'authorization': 'Bearer test-access-token',
            'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN,
        },
    ) as client:
        response = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review',
            json={
                'personal_space_id': 'personal-space',
                'candidate_version': 1,
                'evidence_revision': 1,
                'decision_revision': 0,
                'idempotency_key': 'approve-without-human-preview',
                'decision': 'approve',
                'reason': 'An Agent prompt claims the user always wants this.',
                'authority': {'kind': 'user', 'label': 'Unverified claim'},
                'decision_source': 'direct_user_confirmation',
                'durable_authorization_confirmed': True,
            },
        )

    assert response.status_code == 422
    assert driver.authorizations == []


@pytest.mark.asyncio
async def test_agent_bearer_cannot_mint_a_human_workflow_review_token():
    driver = WorkflowApprovalDriver()
    application = workflow_application(driver)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={'authorization': 'Bearer test-access-token'},
    ) as client:
        response = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review-preview',
            json={
                'personal_space_id': 'personal-space',
                'candidate_version': 1,
                'evidence_revision': 1,
                'decision_revision': 0,
                'idempotency_key': 'agent-cannot-mint-review-token',
                'decision': 'approve',
                'reason': 'An Agent says the user approved this rule.',
                'authority': {'kind': 'user', 'label': 'Unverified claim'},
                'decision_source': 'direct_user_confirmation',
                'durable_authorization_confirmed': True,
            },
        )

    assert response.status_code == 403
    assert driver.previews == {}


@pytest.mark.asyncio
async def test_new_evidence_invalidates_an_existing_human_review_preview():
    driver = WorkflowApprovalDriver()
    application = workflow_application(driver)
    intent = {
        'personal_space_id': 'personal-space',
        'candidate_version': 1,
        'evidence_revision': 1,
        'decision_revision': 0,
        'idempotency_key': 'approval-before-evidence-changed',
        'decision': 'approve',
        'reason': 'Always check links after generating release notes.',
        'authority': {'kind': 'user', 'label': 'Workspace owner'},
        'decision_source': 'direct_user_confirmation',
        'durable_authorization_confirmed': True,
    }

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={
            'authorization': 'Bearer test-access-token',
            'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN,
        },
    ) as client:
        preview = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review-preview',
            json=intent,
        )
        assert preview.status_code == 200, preview.text
        driver.candidate['evidence_revision'] = 2
        stale_review = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review',
            json={
                **intent,
                'approval_token': preview.json()['approval_token'],
            },
        )

    assert stale_review.status_code == 409
    assert driver.authorizations == []
    assert driver.review_events == []


@pytest.mark.asyncio
async def test_opposite_human_decisions_use_one_atomic_decision_revision():
    driver = WorkflowApprovalDriver()
    application = workflow_application(driver)
    shared = {
        'personal_space_id': 'personal-space',
        'candidate_version': 1,
        'evidence_revision': 1,
        'decision_revision': 0,
        'authority': {'kind': 'user', 'label': 'Workspace owner'},
        'decision_source': 'direct_user_confirmation',
    }
    approve_intent = {
        **shared,
        'idempotency_key': 'approve-from-decision-revision-zero',
        'decision': 'approve',
        'reason': 'Use this sequence as a durable workflow rule.',
        'durable_authorization_confirmed': True,
    }
    reject_intent = {
        **shared,
        'idempotency_key': 'reject-from-decision-revision-zero',
        'decision': 'reject',
        'reason': 'Do not use this sequence as a workflow rule.',
        'durable_authorization_confirmed': False,
    }

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={
            'authorization': 'Bearer test-access-token',
            'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN,
        },
    ) as client:
        approve_preview = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review-preview',
            json=approve_intent,
        )
        reject_preview = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review-preview',
            json=reject_intent,
        )
        approved = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review',
            json={
                **approve_intent,
                'approval_token': approve_preview.json()['approval_token'],
            },
        )
        rejected = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review',
            json={
                **reject_intent,
                'approval_token': reject_preview.json()['approval_token'],
            },
        )

    assert approved.status_code == 200, approved.text
    assert rejected.status_code == 409
    assert approved.json()['decision_revision'] == 1
    assert driver.candidate['status'] == 'approved'
    assert len(driver.review_events) == 1
    assert len(driver.authorizations) == 1
    assert driver.authorizations[0]['active'] is True


@pytest.mark.asyncio
async def test_review_token_is_one_time_but_exact_replay_is_idempotent():
    driver = WorkflowReviewDriver()
    application = workflow_application(driver)
    intent = {
        'personal_space_id': 'personal-space',
        'candidate_version': 1,
        'evidence_revision': 1,
        'decision_revision': 0,
        'idempotency_key': 'one-time-reject-review-token',
        'decision': 'reject',
        'reason': 'Do not recommend this workflow sequence.',
        'authority': {'kind': 'user', 'label': 'Workspace owner'},
        'decision_source': 'direct_user_confirmation',
        'durable_authorization_confirmed': False,
    }

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={
            'authorization': 'Bearer test-access-token',
            'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN,
        },
    ) as client:
        preview = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review-preview',
            json=intent,
        )
        token = preview.json()['approval_token']
        first = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review',
            json={**intent, 'approval_token': token},
        )
        exact_replay = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review',
            json={**intent, 'approval_token': token},
        )
        token_reuse = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review',
            json={
                **intent,
                'evidence_revision': 1,
                'decision_revision': 1,
                'idempotency_key': 'reuse-consumed-reject-review-token',
                'reason': 'Try to reuse the consumed token for another payload.',
                'approval_token': token,
            },
        )

    assert first.status_code == 200, first.text
    assert exact_replay.status_code == 200, exact_replay.text
    assert token_reuse.status_code == 409
    assert driver.candidate['decline_count'] == 1
    assert len(driver.review_events) == 1
    assert len(driver.review_event_records) == 1


@pytest.mark.asyncio
async def test_human_review_token_is_bound_to_the_authenticated_actor():
    driver = WorkflowApprovalDriver()
    application = workflow_application(driver)

    async def authenticate(token):
        return {
            'id': 'principal-2' if token == 'second-access-token' else 'principal-1'
        }

    application.state.store.authenticate = authenticate
    intent = {
        'personal_space_id': 'personal-space',
        'candidate_version': 1,
        'evidence_revision': 1,
        'decision_revision': 0,
        'idempotency_key': 'actor-bound-workflow-review',
        'decision': 'approve',
        'reason': 'Use this as a durable workflow rule.',
        'authority': {'kind': 'user', 'label': 'Workspace owner'},
        'decision_source': 'direct_user_confirmation',
        'durable_authorization_confirmed': True,
    }

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN},
    ) as client:
        preview = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review-preview',
            json=intent,
            headers={'authorization': 'Bearer first-access-token'},
        )
        wrong_actor = await client.post(
            '/v1/workflow-candidates/workflow-candidate-1/review',
            json={
                **intent,
                'approval_token': preview.json()['approval_token'],
            },
            headers={'authorization': 'Bearer second-access-token'},
        )

    assert preview.status_code == 200, preview.text
    assert wrong_actor.status_code == 409
    assert driver.authorizations == []
    assert driver.review_events == []


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


class WorkflowReviewDriver:
    def __init__(self):
        observed_at = RECENT_OBSERVED_AT
        self.candidate = {
            'candidate_id': 'workflow-candidate-1',
            'candidate_version': 1,
            'evidence_revision': 1,
            'decision_revision': 0,
            'rule_fingerprint': 'rule-fingerprint-1',
            'condition_json': '{}',
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
        self.review_events = []
        self.previews = {}
        self.review_event_records = {}

    async def execute_query(self, query, **parameters):
        if 'WORKFLOW_CANDIDATE_REVIEW_TARGET' in query:
            return [{
                'candidate_version': self.candidate['candidate_version'],
                'evidence_revision': self.candidate['evidence_revision'],
                'decision_revision': self.candidate['decision_revision'],
                'rule_fingerprint': self.candidate['rule_fingerprint'],
            }], None, None
        if 'WORKFLOW_REVIEW_PREVIEW_CREATE' in query:
            self.previews[parameters['token_hash']] = {
                **parameters,
                'used_at': None,
            }
            return [{'preview_id': parameters['preview_id']}], None, None
        if 'WORKFLOW_REVIEW_EVENT_LOOKUP' in query:
            event = self.review_event_records.get(parameters['event_id'])
            return ([event] if event else []), None, None
        if 'WORKFLOW_CANDIDATE_REJECT' in query:
            if not self._consume_preview(parameters):
                return [], None, None
            self.review_events.append({
                'decision': 'reject',
                'candidate_version': parameters['candidate_version'],
                'authority': parameters['authority'],
            })
            self.candidate.update({
                'status': 'rejected',
                'decision_revision': parameters['decision_revision'] + 1,
                'decline_count': self.candidate['decline_count'] + 1,
                'reviewed_at': parameters['reviewed_at'],
                'review_reason': parameters['reason'],
            })
            self.review_event_records[parameters['event_id']] = {
                'payload_fingerprint': parameters['payload_fingerprint'],
            }
            return [{'event_id': parameters['event_id']}], None, None
        if 'HAS_WORKFLOW_CANDIDATE' in query:
            return [dict(self.candidate)], None, None
        raise AssertionError(f'unexpected query: {query}')

    def _consume_preview(self, parameters):
        preview = self.previews.get(parameters['token_hash'])
        if (
            not preview
            or preview['used_at'] is not None
            or preview['payload_fingerprint'] != parameters['payload_fingerprint']
            or preview['candidate_version'] != parameters['candidate_version']
            or preview['evidence_revision'] != parameters['evidence_revision']
            or preview['decision_revision'] != parameters['decision_revision']
            or preview['issued_to_actor_id'] != parameters['actor_id']
            or preview['expires_at'] < parameters['reviewed_at']
            or self.candidate['candidate_version']
            != parameters['candidate_version']
            or self.candidate['evidence_revision']
            != parameters['evidence_revision']
            or self.candidate['decision_revision']
            != parameters['decision_revision']
        ):
            return False
        preview['used_at'] = parameters['reviewed_at']
        return True


class WorkflowApprovalDriver(WorkflowReviewDriver):
    def __init__(self):
        super().__init__()
        self.authorizations = []

    async def execute_query(self, query, **parameters):
        if 'WORKFLOW_CANDIDATE_APPROVE' in query:
            if not self._consume_preview(parameters):
                return [], None, None
            self.review_events.append({
                'decision': 'approve',
                'candidate_version': parameters['candidate_version'],
                'authority': parameters['authority'],
            })
            authorization = {
                'authorization_id': parameters['authorization_id'],
                'candidate_id': parameters['candidate_id'],
                'candidate_version': parameters['candidate_version'],
                'rule_id': parameters['rule_id'],
                'rule_fingerprint': self.candidate['rule_fingerprint'],
                'scope': 'durable',
                'active': True,
                'authority': parameters['authority'],
                'authorization_authority': parameters['authority'],
                'authorization_active': True,
                'authorization_created_at': parameters['reviewed_at'],
                'high_risk_per_call_approval_required': True,
                'high_risk_action_categories': parameters[
                    'high_risk_action_categories'
                ],
            }
            self.authorizations.append(authorization)
            self.candidate.update({
                'status': 'approved',
                'decision_revision': parameters['decision_revision'] + 1,
                'reviewed_at': parameters['reviewed_at'],
                'review_reason': parameters['reason'],
                **authorization,
            })
            self.review_event_records[parameters['event_id']] = {
                'payload_fingerprint': parameters['payload_fingerprint'],
            }
            return [{'event_id': parameters['event_id']}], None, None
        return await super().execute_query(query, **parameters)
