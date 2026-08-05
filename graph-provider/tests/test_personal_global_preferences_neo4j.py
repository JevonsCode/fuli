import asyncio
import hashlib
import json
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


HUMAN_REVIEW_TOKEN = 'neo4j-human-review-token-not-shared-with-agents'


@pytest.mark.asyncio
async def test_real_neo4j_parent_convergence_serializes_and_revalidates_exact_state():
    uri = os.getenv('FULI_TEST_NEO4J_URI')
    password = os.getenv('FULI_TEST_NEO4J_PASSWORD')
    ephemeral = os.getenv('FULI_TEST_NEO4J_EPHEMERAL') == '1'
    if not uri or not password or not ephemeral:
        pytest.skip(
            'set FULI_TEST_NEO4J_URI, FULI_TEST_NEO4J_PASSWORD, and '
            'FULI_TEST_NEO4J_EPHEMERAL=1 for a disposable database'
        )
    if urlparse(uri).hostname not in {'127.0.0.1', 'localhost', '::1'}:
        pytest.fail('destructive preference integration test requires loopback Neo4j')

    base_driver = AsyncGraphDatabase.driver(uri, auth=('neo4j', password))
    driver = MutatingDriver(base_driver)
    try:
        await base_driver.verify_connectivity()
        await base_driver.execute_query('MATCH (node) DETACH DELETE node')
        for query in PREFERENCE_CONSTRAINTS:
            await base_driver.execute_query(query)
        await seed_preference_graph(base_driver)
        application = preference_application(driver, uri, password)
        source_items = [
            {
                'item_id': 'preference-d',
                'item_kind': 'entity',
                'project_id': 'project-d',
            },
            {
                'item_id': 'preference-e',
                'item_kind': 'entity',
                'project_id': 'project-e',
            },
        ]
        candidate_id = candidate_id_for(source_items)
        headers = {
            'authorization': 'Bearer test-access-token',
            'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN,
        }

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application),
            base_url='http://provider.test',
            headers=headers,
        ) as client:
            options = await scope_options(client, candidate_id, source_items)
            assert options['eligible_target_scopes'] == [
                {
                    'target_scope': 'parent_project',
                    'target_project_id': 'parent-a',
                    'max_distance': 1,
                },
                {
                    'target_scope': 'personal_global',
                    'target_project_id': None,
                    'max_distance': None,
                },
            ]
            approve = decision_intent(
                options['candidate_version'],
                source_items,
                decision='approve',
                decision_revision=0,
                idempotency_key='neo4j-parent-a-approve',
            )
            approved = await preview_and_apply(client, candidate_id, approve)
            assert approved.status_code == 200, approved.text
            assertion_id = approved.json()['global_assertion_id']
            assertion_rows, _, _ = await base_driver.execute_query(
                '''
                MATCH (assertion:Entity {uuid: $assertion_id})
                RETURN assertion.fuli_preference_scope AS scope,
                       assertion.fuli_preference_project_id AS project_id,
                       assertion.fuli_inheritance_mode AS inheritance_mode
                ''',
                assertion_id=assertion_id,
            )
            assert dict(assertion_rows[0]) == {
                'scope': 'project',
                'project_id': 'parent-a',
                'inheritance_mode': 'descendants',
            }

            approve_again = decision_intent(
                options['candidate_version'],
                source_items,
                decision='approve',
                decision_revision=1,
                idempotency_key='neo4j-concurrent-approve',
            )
            reject = decision_intent(
                options['candidate_version'],
                source_items,
                decision='reject',
                decision_revision=1,
                idempotency_key='neo4j-concurrent-reject',
            )
            approve_preview, reject_preview = await asyncio.gather(
                preview(client, candidate_id, approve_again),
                preview(client, candidate_id, reject),
            )
            outcomes = await asyncio.gather(
                apply(
                    client,
                    candidate_id,
                    approve_again,
                    approve_preview['approval_token'],
                ),
                apply(
                    client,
                    candidate_id,
                    reject,
                    reject_preview['approval_token'],
                ),
            )
            assert sorted(response.status_code for response in outcomes) == [200, 409]
            event_rows, _, _ = await base_driver.execute_query(
                '''
                MATCH (event:FuliPersonalGlobalPreferenceDecisionEvent {
                  candidate_id: $candidate_id
                })
                RETURN count(event) AS event_count
                ''',
                candidate_id=candidate_id,
            )
            assert event_rows[0]['event_count'] == 2

            add_parent_intent = decision_intent(
                options['candidate_version'],
                source_items,
                decision='reject',
                decision_revision=2,
                idempotency_key='neo4j-add-parent-toctou',
            )
            add_parent_preview = await preview(
                client,
                candidate_id,
                add_parent_intent,
            )
            driver.before_apply = add_parent_b
            added_parent = await apply(
                client,
                candidate_id,
                add_parent_intent,
                add_parent_preview['approval_token'],
            )
            assert added_parent.status_code == 409, added_parent.text

            expanded_options = await scope_options(
                client,
                candidate_id,
                source_items,
            )
            assert [
                item['target_project_id']
                for item in expanded_options['eligible_target_scopes']
                if item['target_scope'] == 'parent_project'
            ] == ['parent-a', 'parent-b']
            remove_parent_intent = decision_intent(
                expanded_options['candidate_version'],
                source_items,
                decision='reject',
                decision_revision=2,
                idempotency_key='neo4j-remove-parent-toctou',
            )
            remove_parent_preview = await preview(
                client,
                candidate_id,
                remove_parent_intent,
            )
            driver.before_apply = remove_parent_b
            removed_parent = await apply(
                client,
                candidate_id,
                remove_parent_intent,
                remove_parent_preview['approval_token'],
            )
            assert removed_parent.status_code == 409, removed_parent.text

            global_source_items = [
                {
                    'item_id': 'preference-c',
                    'item_kind': 'entity',
                    'project_id': 'project-c',
                },
                *source_items,
            ]
            global_candidate_id = candidate_id_for(global_source_items)
            global_options = await scope_options(
                client,
                global_candidate_id,
                global_source_items,
            )
            assert global_options['eligible_target_scopes'] == [{
                'target_scope': 'personal_global',
                'target_project_id': None,
                'max_distance': None,
            }]
            global_intent = decision_intent(
                global_options['candidate_version'],
                global_source_items,
                decision='approve',
                decision_revision=0,
                idempotency_key='neo4j-no-common-parent-global-approve',
                target_scope='personal_global',
                target_project_id=None,
            )
            global_approved = await preview_and_apply(
                client,
                global_candidate_id,
                global_intent,
            )
            assert global_approved.status_code == 200, global_approved.text
            global_assertion_rows, _, _ = await base_driver.execute_query(
                '''
                MATCH (assertion:Entity {
                  uuid: $assertion_id,
                  fuli_preference_scope: 'global'
                })
                RETURN assertion.fuli_preference_project_id AS project_id,
                       assertion.fuli_inheritance_mode AS inheritance_mode
                ''',
                assertion_id=global_approved.json()['global_assertion_id'],
            )
            assert [dict(row) for row in global_assertion_rows] == [{
                'project_id': None,
                'inheritance_mode': 'local_only',
            }]
            for project_id in [None, 'project-c', 'project-d', 'project-e']:
                parameters = {'personal_space_id': 'personal-space'}
                if project_id:
                    parameters['personal_project_id'] = project_id
                collaboration = await client.get(
                    '/v1/collaboration-preferences',
                    params=parameters,
                )
                assert collaboration.status_code == 200, collaboration.text
            decision_status = await client.post(
                '/v1/personal-global-preference-candidates/decision-status',
                json={
                    'personal_space_id': 'personal-space',
                    'candidates': [
                        {
                            'candidate_id': candidate_id,
                            'candidate_version': options['candidate_version'],
                        },
                        {
                            'candidate_id': global_candidate_id,
                            'candidate_version': global_options[
                                'candidate_version'
                            ],
                        },
                    ],
                },
            )
            assert decision_status.status_code == 200, decision_status.text

            current_options = await scope_options(
                client,
                candidate_id,
                source_items,
            )
            title_drift_intent = decision_intent(
                current_options['candidate_version'],
                source_items,
                decision='reject',
                decision_revision=2,
                idempotency_key='neo4j-title-toctou',
            )
            title_preview = await preview(
                client,
                candidate_id,
                title_drift_intent,
            )
            driver.before_apply = mutate_source_title
            title_drift = await apply(
                client,
                candidate_id,
                title_drift_intent,
                title_preview['approval_token'],
            )
            assert title_drift.status_code == 409, title_drift.text

        unchanged_rows, _, _ = await base_driver.execute_query(
            '''
            MATCH (source:Entity)
            WHERE source.uuid IN [
              'preference-c', 'preference-d', 'preference-e'
            ]
            RETURN source.uuid AS id,
                   source.fuli_preference_scope AS scope,
                   source.fuli_preference_project_id AS project_id,
                   source.fuli_invalid_at AS invalid_at
            ORDER BY id
            ''',
        )
        assert [dict(row) for row in unchanged_rows] == [
            {
                'id': 'preference-c',
                'scope': 'project',
                'project_id': 'project-c',
                'invalid_at': None,
            },
            {
                'id': 'preference-d',
                'scope': 'project',
                'project_id': 'project-d',
                'invalid_at': None,
            },
            {
                'id': 'preference-e',
                'scope': 'project',
                'project_id': 'project-e',
                'invalid_at': None,
            },
        ]
    finally:
        await base_driver.execute_query('MATCH (node) DETACH DELETE node')
        await base_driver.close()


class MutatingDriver:
    def __init__(self, driver):
        self.driver = driver
        self.before_apply = None

    async def execute_query(self, query, **parameters):
        if 'fuli:apply-personal-global-decision' in query and self.before_apply:
            mutation = self.before_apply
            self.before_apply = None
            await mutation(self.driver)
        return await self.driver.execute_query(query, **parameters)


async def scope_options(client, candidate_id, source_items):
    response = await client.post(
        f'/v1/personal-global-preference-candidates/{candidate_id}/scope-options',
        json={
            'personal_space_id': 'personal-space',
            'source_items': source_items,
            'preference_key': 'alignment.comments.explain-function',
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


async def preview(client, candidate_id, intent):
    response = await client.post(
        f'/v1/personal-global-preference-candidates/{candidate_id}/decision-preview',
        json=intent,
    )
    assert response.status_code == 200, response.text
    return response.json()


async def apply(client, candidate_id, intent, approval_token):
    return await client.post(
        f'/v1/personal-global-preference-candidates/{candidate_id}/decision',
        json={**intent, 'approval_token': approval_token},
    )


async def preview_and_apply(client, candidate_id, intent):
    reviewed = await preview(client, candidate_id, intent)
    return await apply(client, candidate_id, intent, reviewed['approval_token'])


def decision_intent(
    candidate_version,
    source_items,
    *,
    decision,
    decision_revision,
    idempotency_key,
    target_scope='parent_project',
    target_project_id='parent-a',
):
    result = {
        'personal_space_id': 'personal-space',
        'candidate_version': candidate_version,
        'decision_revision': decision_revision,
        'source_items': source_items,
        'preference_key': 'alignment.comments.explain-function',
        'target_scope': target_scope,
        'target_project_id': target_project_id,
        'decision': decision,
        'human_confirmation_reason': (
            'MOCK integration reviewer checked every source and target.'
        ),
        'confirmed_at': '2026-08-04T00:00:00Z',
        'session_id': 'neo4j-preference-review',
        'idempotency_key': idempotency_key,
    }
    if decision == 'approve':
        result.update({
            'global_title': 'Shared comment preference',
            'global_instruction': 'Explain function behavior in comments.',
            'profile_aspect': 'judgment_preference',
        })
    return result


def candidate_id_for(source_items):
    item_ids = sorted(item['item_id'] for item in source_items)
    digest = hashlib.sha256('\n'.join(item_ids).encode()).hexdigest()[:20]
    return f'personal-global-{digest}'


def preference_application(driver, uri, password):
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        human_review_token=HUMAN_REVIEW_TOKEN,
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


async def seed_preference_graph(driver):
    basis = json.dumps({
        'existence_reason': 'MOCK user explicitly expressed this preference.',
        'quadrant_reason': 'MOCK preference was directly confirmed.',
        'proposed_by': {'kind': 'user', 'label': 'MOCK user'},
        'confirmed_by': {'kind': 'user', 'label': 'MOCK reviewer'},
        'confirmed_at': '2026-08-03T00:00:00Z',
        'agent_policy_version': None,
    }, ensure_ascii=False)
    attributes = json.dumps({
        'preferenceKey': 'alignment.comments.explain-function',
        'audience': 'project contributors',
    }, ensure_ascii=False)
    await driver.execute_query(
        '''
        CREATE (principal:FuliPrincipal {id: 'principal-1'})
        CREATE (space:FuliSpace {
          id: 'personal-space', kind: 'personal', group_id: 'personal-group'
        })
        CREATE (a:FuliPersonalProject {id: 'parent-a', project_id: 'parent-a'})
        CREATE (b:FuliPersonalProject {id: 'parent-b', project_id: 'parent-b'})
        CREATE (c:FuliPersonalProject {id: 'project-c', project_id: 'project-c'})
        CREATE (d:FuliPersonalProject {id: 'project-d', project_id: 'project-d'})
        CREATE (e:FuliPersonalProject {id: 'project-e', project_id: 'project-e'})
        CREATE (principal)-[:OWNS]->(space)
        CREATE (space)-[:CONTAINS_PROJECT]->(a)
        CREATE (space)-[:CONTAINS_PROJECT]->(b)
        CREATE (space)-[:CONTAINS_PROJECT]->(c)
        CREATE (space)-[:CONTAINS_PROJECT]->(d)
        CREATE (space)-[:CONTAINS_PROJECT]->(e)
        CREATE (d)-[:PERSONAL_PROJECT_RELATION {
          id: 'd-a', relation_type: 'PART_OF', status: 'active',
          confirmation_authority: 'human_review'
        }]->(a)
        CREATE (e)-[:PERSONAL_PROJECT_RELATION {
          id: 'e-a', relation_type: 'PART_OF', status: 'active',
          confirmation_authority: 'human_review'
        }]->(a)
        CREATE (source_c:Entity {
          uuid: 'preference-c', group_id: 'personal-group',
          name: 'Project C comment preference',
          summary: 'Explain function behavior in comments.',
          fuli_key: 'alignment:comment:project-c',
          fuli_type: 'PersonalPreference',
          fuli_profile_aspect: 'judgment_preference',
          fuli_preference_scope: 'project',
          fuli_preference_project_id: 'project-c',
          fuli_inheritance_mode: 'local_only',
          fuli_confirmation_status: 'confirmed',
          fuli_confirmation_basis_json: $basis,
          fuli_attributes_json: $attributes,
          fuli_usage_generation: 1,
          fuli_negative_evidence_count: 0,
          fuli_requires_attention: false
        })
        CREATE (source_d:Entity {
          uuid: 'preference-d', group_id: 'personal-group',
          name: 'Project D comment preference',
          summary: 'Explain function behavior in comments.',
          fuli_key: 'alignment:comment:project-d',
          fuli_type: 'PersonalPreference',
          fuli_profile_aspect: 'judgment_preference',
          fuli_preference_scope: 'project',
          fuli_preference_project_id: 'project-d',
          fuli_inheritance_mode: 'local_only',
          fuli_confirmation_status: 'confirmed',
          fuli_confirmation_basis_json: $basis,
          fuli_attributes_json: $attributes,
          fuli_usage_generation: 1,
          fuli_negative_evidence_count: 0,
          fuli_requires_attention: false
        })
        CREATE (source_e:Entity {
          uuid: 'preference-e', group_id: 'personal-group',
          name: 'Project E comment preference',
          summary: 'Explain function behavior in comments, in Chinese.',
          fuli_key: 'alignment:comment:project-e',
          fuli_type: 'PersonalPreference',
          fuli_profile_aspect: 'judgment_preference',
          fuli_preference_scope: 'project',
          fuli_preference_project_id: 'project-e',
          fuli_inheritance_mode: 'local_only',
          fuli_confirmation_status: 'confirmed',
          fuli_confirmation_basis_json: $basis,
          fuli_attributes_json: $attributes,
          fuli_usage_generation: 1,
          fuli_negative_evidence_count: 0,
          fuli_requires_attention: false
        })
        CREATE (episode_d:Episodic {
          uuid: 'episode-d', group_id: 'personal-group',
          fuli_source_uri: 'https://fixtures.invalid/project-d/preference'
        })
        CREATE (episode_c:Episodic {
          uuid: 'episode-c', group_id: 'personal-group',
          fuli_source_uri: 'https://fixtures.invalid/project-c/preference'
        })
        CREATE (episode_e:Episodic {
          uuid: 'episode-e', group_id: 'personal-group',
          fuli_source_uri: 'https://fixtures.invalid/project-e/preference'
        })
        CREATE (episode_c)-[:MENTIONS]->(source_c)
        CREATE (episode_d)-[:MENTIONS]->(source_d)
        CREATE (episode_e)-[:MENTIONS]->(source_e)
        ''',
        basis=basis,
        attributes=attributes,
    )


async def add_parent_b(driver):
    await driver.execute_query(
        '''
        MATCH (d:FuliPersonalProject {project_id: 'project-d'}),
              (e:FuliPersonalProject {project_id: 'project-e'}),
              (b:FuliPersonalProject {project_id: 'parent-b'})
        MERGE (d)-[:PERSONAL_PROJECT_RELATION {
          id: 'd-b', relation_type: 'PART_OF', status: 'active',
          confirmation_authority: 'human_review'
        }]->(b)
        MERGE (e)-[:PERSONAL_PROJECT_RELATION {
          id: 'e-b', relation_type: 'PART_OF', status: 'active',
          confirmation_authority: 'human_review'
        }]->(b)
        ''',
    )


async def remove_parent_b(driver):
    await driver.execute_query(
        '''
        MATCH ()-[relation:PERSONAL_PROJECT_RELATION]->
              (:FuliPersonalProject {project_id: 'parent-b'})
        WHERE relation.id IN ['d-b', 'e-b']
        DELETE relation
        ''',
    )


async def mutate_source_title(driver):
    await driver.execute_query(
        '''
        MATCH (source:Entity {uuid: 'preference-e'})
        SET source.name = 'Changed after validation'
        ''',
    )


def async_result(value):
    async def result(*_args, **_kwargs):
        return value

    return result


class ZeroEmbedder:
    async def create(self, _value):
        return [0.0] * 64


PREFERENCE_CONSTRAINTS = [
    'CREATE CONSTRAINT fuli_personal_global_preference_decision '
    'IF NOT EXISTS FOR (node:FuliPersonalGlobalPreferenceDecision) '
    'REQUIRE (node.space_id, node.candidate_id) IS UNIQUE',
    'CREATE CONSTRAINT fuli_personal_global_preference_event '
    'IF NOT EXISTS FOR (node:FuliPersonalGlobalPreferenceDecisionEvent) '
    'REQUIRE node.id IS UNIQUE',
    'CREATE CONSTRAINT fuli_personal_global_preference_preview '
    'IF NOT EXISTS FOR (node:FuliPersonalGlobalPreferenceDecisionPreview) '
    'REQUIRE node.id IS UNIQUE',
    'CREATE CONSTRAINT fuli_personal_global_preference_preview_token '
    'IF NOT EXISTS FOR (node:FuliPersonalGlobalPreferenceDecisionPreview) '
    'REQUIRE node.token_hash IS UNIQUE',
]
