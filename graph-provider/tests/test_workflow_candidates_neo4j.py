import asyncio
import os
from types import SimpleNamespace
from urllib.parse import urlparse

import httpx
import pytest
from neo4j import AsyncGraphDatabase

os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'test-password')

from fuli_graph.app import create_app
from fuli_graph.config import Settings


HUMAN_REVIEW_TOKEN = 'integration-human-review-token-not-shared-with-agents'
WORKFLOW_OBSERVATION_TOKEN = (
    'integration-workflow-observation-token-for-mcp-host'
)


@pytest.mark.asyncio
async def test_real_neo4j_persists_evidence_and_serializes_opposite_reviews():
    uri = os.getenv('FULI_TEST_NEO4J_URI')
    password = os.getenv('FULI_TEST_NEO4J_PASSWORD')
    ephemeral = os.getenv('FULI_TEST_NEO4J_EPHEMERAL') == '1'
    if not uri or not password or not ephemeral:
        pytest.skip(
            'set FULI_TEST_NEO4J_URI, FULI_TEST_NEO4J_PASSWORD, and '
            'FULI_TEST_NEO4J_EPHEMERAL=1 for a disposable database'
        )
    if urlparse(uri).hostname not in {'127.0.0.1', 'localhost', '::1'}:
        pytest.fail('destructive workflow integration test requires loopback Neo4j')

    driver = AsyncGraphDatabase.driver(uri, auth=('neo4j', password))
    fresh_driver = None
    try:
        await driver.verify_connectivity()
        await driver.execute_query('MATCH (node) DETACH DELETE node')
        for query in WORKFLOW_CONSTRAINTS:
            await driver.execute_query(query)
        await driver.execute_query(
            '''
            CREATE (principal:FuliPrincipal {id: 'principal-1'})
            CREATE (space:FuliSpace {
              id: 'personal-space',
              kind: 'personal',
              group_id: 'personal-group'
            })
            CREATE (project:FuliPersonalProject {
              id: 'travel-d',
              project_id: 'travel-d'
            })
            CREATE (principal)-[:OWNS]->(space)
            CREATE (space)-[:CONTAINS_PROJECT]->(project)
            ''',
        )
        application = workflow_application(driver, uri, password)

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url='http://provider.test',
            headers={'authorization': 'Bearer test-access-token'},
        ) as client:
            untrusted_relationship_ids = []
            for occurrence in range(3):
                untrusted = await client.post(
                    '/v1/knowledge/commits',
                    json=generic_workflow_commit(occurrence),
                )
                assert untrusted.status_code == 200, untrusted.text
                untrusted_relationship_ids.extend(
                    untrusted.json()['relationship_ids']
                )
            await driver.execute_query(
                '''
                UNWIND $relationship_ids AS relationship_id
                MATCH ()-[evidence:RELATES_TO {uuid: relationship_id}]->()
                SET evidence.fuli_negative_evidence_count = 7
                ''',
                relationship_ids=untrusted_relationship_ids,
            )
            untrusted_search = await client.post(
                '/v1/workflow-candidates/search',
                json={'personal_space_id': 'personal-space'},
            )
            assert untrusted_search.json()['candidates'] == []

            actor_only_observation = await client.post(
                '/v1/workflow-observations',
                json=workflow_observation(
                    0,
                    condition={'releaseChannel': 'draft'},
                ),
            )
            assert actor_only_observation.status_code == 403
            host_headers = {
                'x-fuli-workflow-observation-token': (
                    WORKFLOW_OBSERVATION_TOKEN
                ),
            }

            trusted_relationship_ids = []
            for occurrence in range(3):
                committed = await client.post(
                    '/v1/workflow-observations',
                    json=workflow_observation(
                        occurrence,
                        condition={'releaseChannel': 'draft'},
                    ),
                    headers=host_headers,
                )
                assert committed.status_code == 200, committed.text
                trusted_relationship_ids.extend(
                    committed.json()['relationship_ids']
                )
            listed = await client.post(
                '/v1/workflow-candidates/search',
                json={'personal_space_id': 'personal-space'},
            )
            candidate = listed.json()['candidates'][0]
            assert candidate['occurrence_count'] == 3
            assert candidate['distinct_session_count'] == 3
            assert candidate['candidate_version'] == 1
            assert candidate['evidence_revision'] == 1
            assert candidate['confirmation_authority'] == 'agent_proposed'
            assert candidate['negative_evidence_count'] == 0
            evidence_records, _, _ = await driver.execute_query(
                '''
                MATCH (candidate:FuliWorkflowCandidate {id: $candidate_id})
                RETURN candidate.evidence_ids AS evidence_ids
                ''',
                candidate_id=candidate['candidate_id'],
            )
            assert set(evidence_records[0]['evidence_ids']) == set(
                trusted_relationship_ids
            )
            assert set(evidence_records[0]['evidence_ids']).isdisjoint(
                untrusted_relationship_ids
            )

            shared = {
                'personal_space_id': 'personal-space',
                'candidate_version': 1,
                'evidence_revision': 1,
                'decision_revision': 0,
                'authority': {'kind': 'user', 'label': 'Integration reviewer'},
                'decision_source': 'direct_user_confirmation',
            }
            approve_intent = {
                **shared,
                'idempotency_key': 'integration-approve-review',
                'decision': 'approve',
                'reason': 'Approve the durable link-check workflow.',
                'durable_authorization_confirmed': True,
            }
            reject_intent = {
                **shared,
                'idempotency_key': 'integration-reject-review',
                'decision': 'reject',
                'reason': 'Reject the durable link-check workflow.',
                'durable_authorization_confirmed': False,
            }
            human_headers = {
                'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN,
            }
            approve_preview = await client.post(
                f"/v1/workflow-candidates/{candidate['candidate_id']}/review-preview",
                json=approve_intent,
                headers=human_headers,
            )
            reject_preview = await client.post(
                f"/v1/workflow-candidates/{candidate['candidate_id']}/review-preview",
                json=reject_intent,
                headers=human_headers,
            )
            assert approve_preview.status_code == 200, approve_preview.text
            assert reject_preview.status_code == 200, reject_preview.text
            approve_payload = {
                **approve_intent,
                'approval_token': approve_preview.json()['approval_token'],
            }
            reject_payload = {
                **reject_intent,
                'approval_token': reject_preview.json()['approval_token'],
            }
            approve_response, reject_response = await asyncio.gather(
                client.post(
                    f"/v1/workflow-candidates/{candidate['candidate_id']}/review",
                    json=approve_payload,
                    headers=human_headers,
                ),
                client.post(
                    f"/v1/workflow-candidates/{candidate['candidate_id']}/review",
                    json=reject_payload,
                    headers=human_headers,
                ),
            )
            assert sorted([
                approve_response.status_code,
                reject_response.status_code,
            ]) == [200, 409]
            winning_payload = (
                approve_payload
                if approve_response.status_code == 200
                else reject_payload
            )
            exact_replay = await client.post(
                f"/v1/workflow-candidates/{candidate['candidate_id']}/review",
                json=winning_payload,
                headers=human_headers,
            )
            assert exact_replay.status_code == 200, exact_replay.text

            fourth = await client.post(
                '/v1/workflow-observations',
                json=workflow_observation(
                    3,
                    condition={'releaseChannel': 'draft'},
                ),
                headers=host_headers,
            )
            assert fourth.status_code == 200, fourth.text
            for occurrence in range(4, 7):
                changed_rule = await client.post(
                    '/v1/workflow-observations',
                    json=workflow_observation(
                        occurrence,
                        condition={'releaseChannel': 'final'},
                    ),
                    headers=host_headers,
                )
                assert changed_rule.status_code == 200, changed_rule.text

        event_records, _, _ = await driver.execute_query(
            '''
            MATCH (:FuliWorkflowCandidate {id: $candidate_id})-
                  [:HAS_WORKFLOW_REVIEW_EVENT]->(event)
            RETURN count(event) AS event_count
            ''',
            candidate_id=candidate['candidate_id'],
        )
        preview_records, _, _ = await driver.execute_query(
            '''
            MATCH (:FuliWorkflowCandidate {id: $candidate_id})-
                  [:HAS_WORKFLOW_REVIEW_PREVIEW]->(preview)
            WHERE preview.used_at IS NOT NULL
            RETURN count(preview) AS used_count
            ''',
            candidate_id=candidate['candidate_id'],
        )
        assert event_records[0]['event_count'] == 1
        assert preview_records[0]['used_count'] == 1

        fresh_driver = AsyncGraphDatabase.driver(uri, auth=('neo4j', password))
        fresh_application = workflow_application(fresh_driver, uri, password)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=fresh_application),
            base_url='http://fresh-provider.test',
            headers={'authorization': 'Bearer fresh-access-token'},
        ) as client:
            fresh_read = await client.post(
                '/v1/workflow-candidates/search',
                json={'personal_space_id': 'personal-space'},
            )
        persisted = fresh_read.json()['candidates'][0]
        assert persisted['candidate_id'] == candidate['candidate_id']
        assert persisted['candidate_version'] == 2
        assert persisted['evidence_revision'] == 3
        assert persisted['decision_revision'] == 2
        assert persisted['condition'] == {'releaseChannel': 'final'}
        assert persisted['status'] == 'pending'
        assert persisted['execution_authorized'] is False
    finally:
        if fresh_driver is not None:
            await fresh_driver.close()
        await driver.execute_query('MATCH (node) DETACH DELETE node')
        await driver.close()


def workflow_application(driver, uri, password):
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        human_review_token=HUMAN_REVIEW_TOKEN,
        workflow_observation_token=WORKFLOW_OBSERVATION_TOKEN,
        neo4j_uri=uri,
        neo4j_password=password,
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


def workflow_observation(occurrence, *, condition):
    return {
        'personal_space_id': 'personal-space',
        'personal_project_id': 'travel-d',
        'host_session_id': f'integration-session-{occurrence}',
        'observation_id': f'integration-workflow-observation-{occurrence}',
        'from_step': {
            'action_id': 'step-x',
            'name': 'Generate release notes',
            'summary': 'Generate release notes.',
        },
        'to_step': {
            'action_id': 'step-y',
            'name': 'Check links',
            'summary': 'Check links.',
        },
        'workflow_key': 'release-notes-link-check',
        'condition': condition,
        'observed_at': f'2026-08-{occurrence + 1:02d}T08:00:00Z',
        'evidence_summary': (
            'Generating release notes was followed by checking links.'
        ),
        'source_application': 'other',
    }


def generic_workflow_commit(occurrence):
    basis = {
        'existence_reason': 'Agent-submitted MOCK observation.',
        'quadrant_reason': 'Behavioral evidence is not user authorization.',
        'proposed_by': {'kind': 'agent', 'label': 'Untrusted test agent'},
        'confirmed_by': {'kind': 'user', 'label': 'MOCK human reviewer'},
        'confirmed_at': f'2026-07-{occurrence + 1:02d}T08:01:00Z',
    }
    return {
        'space_id': 'personal-space',
        'personal_project_id': 'travel-d',
        'episode': {
            'idempotency_key': f'untrusted-workflow-observation-{occurrence}',
            'session_id': f'forged-agent-session-{occurrence}',
            'name': 'Agent-submitted X then Y',
            'source_kind': 'mock_test',
            'source_description': 'Generic knowledge commit cannot attest a host session.',
            'source_application': 'other',
            'reference_time': f'2026-08-{occurrence + 1:02d}T08:00:00Z',
            'entities': [
                {
                    'key': 'step-x',
                    'name': 'Generate release notes',
                    'type': 'WorkflowStep',
                    'summary': 'Generate release notes.',
                    'confirmation_status': 'confirmed',
                    'confirmation_basis': basis,
                },
                {
                    'key': 'step-y',
                    'name': 'Check links',
                    'type': 'WorkflowStep',
                    'summary': 'Check links.',
                    'confirmation_status': 'confirmed',
                    'confirmation_basis': basis,
                },
            ],
            'relationships': [{
                'key': 'release-notes-link-check',
                'source': 'step-x',
                'target': 'step-y',
                'type': 'RECOMMENDS_NEXT',
                'fact': (
                    'Generating release notes was followed by checking links.'
                ),
                'origin_quadrant': 'unknown_known',
                'confirmation_status': 'confirmed',
                'confirmation_basis': basis,
                'reasoning_summary': 'Agent-supplied behavioral claim only.',
                'attributes': {'workflowCondition': {'releaseChannel': 'draft'}},
            }],
        },
    }


def async_result(value):
    async def result(*_args, **_kwargs):
        return value
    return result


class ZeroEmbedder:
    async def create_batch(self, values):
        return [[0.0] * 384 for _ in values]


WORKFLOW_CONSTRAINTS = [
    'CREATE CONSTRAINT fuli_workflow_candidate_id IF NOT EXISTS '
    'FOR (node:FuliWorkflowCandidate) REQUIRE node.id IS UNIQUE',
    'CREATE CONSTRAINT fuli_workflow_review_event_id IF NOT EXISTS '
    'FOR (node:FuliWorkflowReviewEvent) REQUIRE node.id IS UNIQUE',
    'CREATE CONSTRAINT fuli_workflow_review_preview_id IF NOT EXISTS '
    'FOR (node:FuliWorkflowReviewPreview) REQUIRE node.id IS UNIQUE',
    'CREATE CONSTRAINT fuli_workflow_review_preview_token IF NOT EXISTS '
    'FOR (node:FuliWorkflowReviewPreview) REQUIRE node.token_hash IS UNIQUE',
    'CREATE CONSTRAINT fuli_workflow_rule_id IF NOT EXISTS '
    'FOR (node:FuliWorkflowRule) REQUIRE node.id IS UNIQUE',
    'CREATE CONSTRAINT fuli_workflow_authorization_id IF NOT EXISTS '
    'FOR (node:FuliWorkflowAuthorization) REQUIRE node.id IS UNIQUE',
]
