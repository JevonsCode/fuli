import asyncio
import hashlib
import json
import os
from datetime import UTC, datetime
from types import SimpleNamespace

import httpx
import pytest

os.environ.setdefault('FULI_BOOTSTRAP_TOKEN', 'test-bootstrap-token-1234')
os.environ.setdefault('FULI_NEO4J_PASSWORD', 'test-password')

from fuli_graph.app import create_app
from fuli_graph.config import Settings

HUMAN_REVIEW_TOKEN = 'test-human-review-token-not-shared-with-agents'


@pytest.mark.asyncio
async def test_personal_global_decision_is_version_bound_ordered_and_replay_safe():
    driver = PersonalGlobalDecisionDriver()
    application = decision_application(driver)
    source_items = [
        {
            'item_id': 'entity-travel-d',
            'item_kind': 'entity',
            'project_id': 'travel-d',
        },
        {
            'item_id': 'entity-preference-e',
            'item_kind': 'entity',
            'project_id': 'preference-e',
        },
    ]
    candidate_id = candidate_id_for(source_items)
    candidate_version = candidate_version_for(driver.source_snapshots(source_items))
    approve = decision_intent(
        candidate_version,
        source_items,
        decision='approve',
        idempotency_key='scope-approve-2026-08-03',
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={
            'authorization': 'Bearer test-access-token',
            'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN,
        },
    ) as client:
        human_headers = {
            'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN,
        }
        preview = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision-preview',
            json=approve,
            headers=human_headers,
        )
        assert preview.status_code == 200, preview.text
        assert preview.json()['candidate_version'] == candidate_version
        assert preview.json()['source_snapshots'][0]['key'].startswith('alignment:')
        assert preview.json()['source_snapshots'][0]['preference_key'] == (
            'alignment.comments.explain-function'
        )
        assert preview.json()['source_snapshots'][0]['preference_qualifiers'] == {
            'audience': 'project contributors',
        }

        applied = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision',
            json={**approve, 'approval_token': preview.json()['approval_token']},
        )
        assert applied.status_code == 200, applied.text
        assert applied.json()['decision'] == 'approved'
        assert applied.json()['global_assertion_active'] is True
        approved_assertion_id = applied.json()['global_assertion_id']
        assert approved_assertion_id

        status = await client.post(
            '/v1/personal-global-preference-candidates/decision-status',
            json={
                'personal_space_id': 'personal-space',
                'candidates': [{
                    'candidate_id': candidate_id,
                    'candidate_version': candidate_version,
                }],
            },
        )
        assert status.status_code == 200, status.text
        assert status.json()['decisions'] == [{
            **status.json()['decisions'][0],
            'candidate_id': candidate_id,
            'candidate_version': candidate_version,
            'decision': 'approved',
            'global_assertion_id': approved_assertion_id,
            'global_assertion_active': True,
        }]

        replay = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision',
            json={**approve, 'approval_token': preview.json()['approval_token']},
        )
        assert replay.status_code == 200, replay.text
        assert replay.json()['decision_event_id'] == applied.json()['decision_event_id']
        assert driver.applied_count == 1

        reject_intent = decision_intent(
            candidate_version,
            source_items,
            decision='reject',
            idempotency_key='scope-reject-2026-08-03',
            decision_revision=1,
        )
        reject_preview = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision-preview',
            json=reject_intent,
            headers=human_headers,
        )
        rejected = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision',
            json={
                **reject_intent,
                'approval_token': reject_preview.json()['approval_token'],
            },
        )
        assert rejected.status_code == 200, rejected.text
        assert rejected.json()['decision'] == 'rejected'
        assert rejected.json()['global_assertion_id'] is None
        assert rejected.json()['global_assertion_active'] is False
        assert driver.assertions[approved_assertion_id]['active'] is False
        assert driver.decisions[candidate_id]['decision'] == 'rejected'
        assert [event['decision'] for event in driver.events] == [
            'approved',
            'rejected',
        ]

        old_approve_retry = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision',
            json={**approve, 'approval_token': preview.json()['approval_token']},
        )
        assert old_approve_retry.status_code == 200, old_approve_retry.text
        assert old_approve_retry.json()['global_assertion_active'] is False

        driver.sources['entity-preference-e']['instruction'] += '并解释原因。'
        driver.sources['entity-preference-e']['human_change_version'] = 1
        changed_version = candidate_version_for(driver.source_snapshots(source_items))
        drift_status = await client.post(
            '/v1/personal-global-preference-candidates/decision-status',
            json={
                'personal_space_id': 'personal-space',
                'candidates': [{
                    'candidate_id': candidate_id,
                    'candidate_version': changed_version,
                }],
            },
        )
        assert drift_status.status_code == 200, drift_status.text
        assert drift_status.json()['decisions'] == []
        assert drift_status.json()['revisions'] == [{
            'candidate_id': candidate_id,
            'decision_revision': 2,
            'current_candidate_version': candidate_version,
        }]
        changed_intent = decision_intent(
            changed_version,
            source_items,
            decision='reject',
            idempotency_key='scope-reject-changed-source-version',
            decision_revision=2,
        )
        changed_preview = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision-preview',
            json=changed_intent,
            headers=human_headers,
        )
        assert changed_preview.status_code == 200, changed_preview.text
        changed_applied = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision',
            json={
                **changed_intent,
                'approval_token': changed_preview.json()['approval_token'],
            },
        )
        assert changed_applied.status_code == 200, changed_applied.text
        assert changed_applied.json()['decision_revision'] == 3


@pytest.mark.asyncio
async def test_changed_source_invalidates_preview_and_old_rejection_does_not_suppress():
    driver = PersonalGlobalDecisionDriver()
    application = decision_application(driver)
    source_items = [
        {'item_id': 'entity-travel-d', 'item_kind': 'entity', 'project_id': 'travel-d'},
        {
            'item_id': 'entity-preference-e',
            'item_kind': 'entity',
            'project_id': 'preference-e',
        },
    ]
    candidate_id = candidate_id_for(source_items)
    old_version = candidate_version_for(driver.source_snapshots(source_items))
    intent = decision_intent(
        old_version,
        source_items,
        decision='reject',
        idempotency_key='scope-reject-before-source-change',
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={
            'authorization': 'Bearer test-access-token',
            'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN,
        },
    ) as client:
        preview = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision-preview',
            json=intent,
            headers={
                'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN,
            },
        )
        assert preview.status_code == 200, preview.text

        driver.sources['entity-preference-e']['preference_qualifiers'] = {
            'audience': 'new contributors',
            'language': 'zh-CN',
        }
        stale_apply = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision',
            json={**intent, 'approval_token': preview.json()['approval_token']},
        )
        assert stale_apply.status_code == 409, stale_apply.text

        new_version = candidate_version_for(driver.source_snapshots(source_items))
        assert new_version != old_version
        old_status = await client.post(
            '/v1/personal-global-preference-candidates/decision-status',
            json={
                'personal_space_id': 'personal-space',
                'candidates': [{
                    'candidate_id': candidate_id,
                    'candidate_version': new_version,
                }],
            },
        )
        assert old_status.status_code == 200, old_status.text
        assert old_status.json()['decisions'] == []


@pytest.mark.asyncio
async def test_agent_bearer_cannot_mint_a_human_decision_token():
    driver = PersonalGlobalDecisionDriver()
    application = decision_application(driver)
    source_items = [
        {'item_id': 'entity-travel-d', 'item_kind': 'entity', 'project_id': 'travel-d'},
        {
            'item_id': 'entity-preference-e',
            'item_kind': 'entity',
            'project_id': 'preference-e',
        },
    ]
    candidate_id = candidate_id_for(source_items)
    intent = decision_intent(
        candidate_version_for(driver.source_snapshots(source_items)),
        source_items,
        decision='reject',
        idempotency_key='agent-cannot-mint-review-token',
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={
            'authorization': 'Bearer test-access-token',
        },
    ) as client:
        response = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision-preview',
            json=intent,
        )

    assert response.status_code == 403, response.text
    assert response.json()['detail'] == 'independent human review proof required'
    assert driver.previews == {}


@pytest.mark.asyncio
async def test_opposite_decisions_on_one_revision_have_one_winner():
    driver = PersonalGlobalDecisionDriver()
    application = decision_application(driver)
    source_items = [
        {'item_id': 'entity-travel-d', 'item_kind': 'entity', 'project_id': 'travel-d'},
        {
            'item_id': 'entity-preference-e',
            'item_kind': 'entity',
            'project_id': 'preference-e',
        },
    ]
    candidate_id = candidate_id_for(source_items)
    version = candidate_version_for(driver.source_snapshots(source_items))
    approve = decision_intent(
        version,
        source_items,
        decision='approve',
        idempotency_key='concurrent-approve-revision-zero',
    )
    reject = decision_intent(
        version,
        source_items,
        decision='reject',
        idempotency_key='concurrent-reject-revision-zero',
    )
    human_headers = {'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN}

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={'authorization': 'Bearer test-access-token'},
    ) as client:
        approve_preview, reject_preview = await asyncio.gather(
            client.post(
                f'/v1/personal-global-preference-candidates/{candidate_id}/decision-preview',
                json=approve,
                headers=human_headers,
            ),
            client.post(
                f'/v1/personal-global-preference-candidates/{candidate_id}/decision-preview',
                json=reject,
                headers=human_headers,
            ),
        )
        assert approve_preview.status_code == 200, approve_preview.text
        assert reject_preview.status_code == 200, reject_preview.text
        outcomes = await asyncio.gather(
            client.post(
                f'/v1/personal-global-preference-candidates/{candidate_id}/decision',
                json={
                    **approve,
                    'approval_token': approve_preview.json()['approval_token'],
                },
                headers=human_headers,
            ),
            client.post(
                f'/v1/personal-global-preference-candidates/{candidate_id}/decision',
                json={
                    **reject,
                    'approval_token': reject_preview.json()['approval_token'],
                },
                headers=human_headers,
            ),
        )

    assert sorted(response.status_code for response in outcomes) == [200, 409]
    assert driver.applied_count == 1
    assert len(driver.events) == 1
    assert driver.decisions[candidate_id]['decision_revision'] == 1


@pytest.mark.asyncio
async def test_human_preview_token_is_bound_to_the_authenticated_principal():
    driver = PersonalGlobalDecisionDriver()
    application = decision_application(driver)
    store = application.state.store

    async def authenticate(token):
        return {
            'id': 'principal-2' if token == 'second-access-token' else 'principal-1',
            'name': 'Workspace owner',
        }

    store.authenticate = authenticate
    source_items = [
        {'item_id': 'entity-travel-d', 'item_kind': 'entity', 'project_id': 'travel-d'},
        {
            'item_id': 'entity-preference-e',
            'item_kind': 'entity',
            'project_id': 'preference-e',
        },
    ]
    candidate_id = candidate_id_for(source_items)
    intent = decision_intent(
        candidate_version_for(driver.source_snapshots(source_items)),
        source_items,
        decision='reject',
        idempotency_key='principal-bound-scope-review',
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
    ) as client:
        preview = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision-preview',
            json=intent,
            headers={
                'authorization': 'Bearer test-access-token',
                'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN,
            },
        )
        assert preview.status_code == 200, preview.text
        missing_human_proof = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision',
            json={**intent, 'approval_token': preview.json()['approval_token']},
            headers={'authorization': 'Bearer test-access-token'},
        )
        assert missing_human_proof.status_code == 403, missing_human_proof.text
        transferred = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision',
            json={**intent, 'approval_token': preview.json()['approval_token']},
            headers={
                'authorization': 'Bearer second-access-token',
                'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN,
            },
        )

    assert transferred.status_code == 409, transferred.text
    assert driver.applied_count == 0


@pytest.mark.asyncio
async def test_mock_d_and_e_can_create_a_new_descendant_preference_on_parent_a():
    driver = PersonalGlobalDecisionDriver()
    driver.common_parent_rows = [{
        'target_project_id': 'parent-a',
        'max_distance': 1,
    }]
    application = decision_application(driver)
    source_items = [
        {'item_id': 'entity-travel-d', 'item_kind': 'entity', 'project_id': 'travel-d'},
        {
            'item_id': 'entity-preference-e',
            'item_kind': 'entity',
            'project_id': 'preference-e',
        },
    ]
    candidate_id = candidate_id_for(source_items)
    version = candidate_version_for(
        driver.source_snapshots(source_items),
        driver.eligible_target_scopes(),
    )
    original_sources = json.loads(json.dumps(driver.sources))
    intent = decision_intent(
        version,
        source_items,
        decision='approve',
        idempotency_key='parent-a-approve-review',
        target_scope='parent_project',
        target_project_id='parent-a',
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={'authorization': 'Bearer test-access-token'},
    ) as client:
        options = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/scope-options',
            json={
                'personal_space_id': 'personal-space',
                'source_items': source_items,
                'preference_key': 'alignment.comments.explain-function',
            },
        )
        assert options.status_code == 200, options.text
        assert options.json()['candidate_version'] == version
        assert options.json()['eligible_target_scopes'] == [
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
        preview = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision-preview',
            json=intent,
            headers={'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN},
        )
        assert preview.status_code == 200, preview.text
        applied = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision',
            json={
                **intent,
                'approval_token': preview.json()['approval_token'],
            },
            headers={'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN},
        )

    assert applied.status_code == 200, applied.text
    assert applied.json()['target_scope'] == 'parent_project'
    assert applied.json()['target_project_id'] == 'parent-a'
    assertion = driver.assertions[applied.json()['global_assertion_id']]
    assert assertion['preference_scope'] == 'project'
    assert assertion['preference_project_id'] == 'parent-a'
    assert assertion['inheritance_mode'] == 'descendants'
    assert driver.sources == original_sources


@pytest.mark.asyncio
async def test_mock_three_sources_without_common_parent_offer_global_only_and_reject_writes_none():
    driver = PersonalGlobalDecisionDriver()
    driver.sources['entity-project-c'] = source_snapshot(
        'entity-project-c',
        'project-c',
        'alignment:network:preference:c',
        '这个项目由 AI 开发时，注释要写清楚功能。',
        'https://fixtures.invalid/project-c/preference',
    )
    application = decision_application(driver)
    source_items = [
        {'item_id': 'entity-project-c', 'item_kind': 'entity', 'project_id': 'project-c'},
        {'item_id': 'entity-travel-d', 'item_kind': 'entity', 'project_id': 'travel-d'},
        {
            'item_id': 'entity-preference-e',
            'item_kind': 'entity',
            'project_id': 'preference-e',
        },
    ]
    candidate_id = candidate_id_for(source_items)
    version = candidate_version_for(driver.source_snapshots(source_items))
    intent = decision_intent(
        version,
        source_items,
        decision='reject',
        idempotency_key='three-source-global-reject',
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={'authorization': 'Bearer test-access-token'},
    ) as client:
        options = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/scope-options',
            json={
                'personal_space_id': 'personal-space',
                'source_items': source_items,
                'preference_key': 'alignment.comments.explain-function',
            },
        )
        assert options.status_code == 200, options.text
        assert options.json()['eligible_target_scopes'] == [{
            'target_scope': 'personal_global',
            'target_project_id': None,
            'max_distance': None,
        }]
        preview = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision-preview',
            json=intent,
            headers={'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN},
        )
        rejected = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision',
            json={
                **intent,
                'approval_token': preview.json()['approval_token'],
            },
            headers={'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN},
        )

    assert rejected.status_code == 200, rejected.text
    assert rejected.json()['decision'] == 'rejected'
    assert driver.assertions == {}


@pytest.mark.asyncio
async def test_mock_forged_or_stale_parent_target_is_rejected():
    driver = PersonalGlobalDecisionDriver()
    application = decision_application(driver)
    source_items = [
        {'item_id': 'entity-travel-d', 'item_kind': 'entity', 'project_id': 'travel-d'},
        {
            'item_id': 'entity-preference-e',
            'item_kind': 'entity',
            'project_id': 'preference-e',
        },
    ]
    candidate_id = candidate_id_for(source_items)
    global_version = candidate_version_for(driver.source_snapshots(source_items))
    forged = decision_intent(
        global_version,
        source_items,
        decision='approve',
        idempotency_key='forged-parent-target',
        target_scope='parent_project',
        target_project_id='parent-a',
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={
            'authorization': 'Bearer test-access-token',
            'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN,
        },
    ) as client:
        forged_preview = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision-preview',
            json=forged,
        )
        assert forged_preview.status_code == 409, forged_preview.text

        driver.common_parent_rows = [{
            'target_project_id': 'parent-a',
            'max_distance': 1,
        }]
        parent_version = candidate_version_for(
            driver.source_snapshots(source_items),
            driver.eligible_target_scopes(),
        )
        valid = decision_intent(
            parent_version,
            source_items,
            decision='approve',
            idempotency_key='stale-parent-target',
            target_scope='parent_project',
            target_project_id='parent-a',
        )
        preview = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision-preview',
            json=valid,
        )
        assert preview.status_code == 200, preview.text
        driver.common_parent_rows = []
        stale = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision',
            json={
                **valid,
                'approval_token': preview.json()['approval_token'],
            },
        )

    assert stale.status_code == 409, stale.text
    assert driver.assertions == {}


@pytest.mark.asyncio
async def test_mock_new_common_parent_between_validation_and_write_rejects_old_preview():
    driver = PersonalGlobalDecisionDriver()
    driver.common_parent_rows = [{
        'target_project_id': 'parent-a',
        'max_distance': 1,
    }]
    application = decision_application(driver)
    source_items = [
        {'item_id': 'entity-travel-d', 'item_kind': 'entity', 'project_id': 'travel-d'},
        {
            'item_id': 'entity-preference-e',
            'item_kind': 'entity',
            'project_id': 'preference-e',
        },
    ]
    candidate_id = candidate_id_for(source_items)
    version = candidate_version_for(
        driver.source_snapshots(source_items),
        driver.eligible_target_scopes(),
    )
    intent = decision_intent(
        version,
        source_items,
        decision='approve',
        idempotency_key='parent-option-toctou-review',
        target_scope='parent_project',
        target_project_id='parent-a',
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url='http://provider.test',
        headers={
            'authorization': 'Bearer test-access-token',
            'x-fuli-human-review-token': HUMAN_REVIEW_TOKEN,
        },
    ) as client:
        preview = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision-preview',
            json=intent,
        )
        assert preview.status_code == 200, preview.text
        driver.mutate_parents_before_apply = lambda value: (
            value.common_parent_rows.append({
                'target_project_id': 'parent-b',
                'max_distance': 1,
            })
        )
        applied = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision',
            json={
                **intent,
                'approval_token': preview.json()['approval_token'],
            },
        )

    assert applied.status_code == 409, applied.text
    assert driver.assertions == {}


@pytest.mark.asyncio
@pytest.mark.parametrize('drift_kind', ['title', 'confirmation_basis'])
async def test_mock_review_visible_source_snapshot_drift_rejects_old_preview(
    drift_kind,
):
    driver = PersonalGlobalDecisionDriver()
    application = decision_application(driver)
    source_items = [
        {'item_id': 'entity-travel-d', 'item_kind': 'entity', 'project_id': 'travel-d'},
        {
            'item_id': 'entity-preference-e',
            'item_kind': 'entity',
            'project_id': 'preference-e',
        },
    ]
    candidate_id = candidate_id_for(source_items)
    version = candidate_version_for(driver.source_snapshots(source_items))
    intent = decision_intent(
        version,
        source_items,
        decision='reject',
        idempotency_key=f'source-{drift_kind}-toctou-review',
    )

    def mutate(value):
        source = value.sources['entity-preference-e']
        if drift_kind == 'title':
            source['title'] = 'Changed review-visible title'
        else:
            source['confirmation_basis'] = {
                **source['confirmation_basis'],
                'existence_reason': 'Changed confirmation basis.',
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
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision-preview',
            json=intent,
        )
        assert preview.status_code == 200, preview.text
        driver.mutate_source_before_apply = mutate
        applied = await client.post(
            f'/v1/personal-global-preference-candidates/{candidate_id}/decision',
            json={
                **intent,
                'approval_token': preview.json()['approval_token'],
            },
        )

    assert applied.status_code == 409, applied.text
    assert driver.events == []


def decision_application(driver):
    application = create_app(Settings(
        bootstrap_token='test-bootstrap-token-1234',
        human_review_token=HUMAN_REVIEW_TOKEN,
        neo4j_password='test-password',
    ))
    store = application.state.store
    store.runtime = SimpleNamespace(driver=driver, embedder=ZeroEmbedder())
    store.authenticate = async_value({'id': 'principal-1', 'name': 'Workspace owner'})
    store.authorize = async_value({
        'id': 'personal-space',
        'kind': 'personal',
        'group_id': 'personal-group',
    })
    return application


def decision_intent(
    candidate_version,
    source_items,
    *,
    decision,
    idempotency_key,
    decision_revision=0,
    target_scope='personal_global',
    target_project_id=None,
):
    value = {
        'personal_space_id': 'personal-space',
        'candidate_version': candidate_version,
        'decision_revision': decision_revision,
        'source_items': source_items,
        'preference_key': 'alignment.comments.explain-function',
        'target_scope': target_scope,
        'target_project_id': target_project_id,
        'decision': decision,
        'human_confirmation_reason': (
            '用户已逐项检查原始限定词，并明确确认这次个人全局范围判断。'
        ),
        'confirmed_at': '2026-08-03T12:00:00Z',
        'session_id': 'scope-review-session',
        'idempotency_key': idempotency_key,
    }
    if decision == 'approve':
        value.update({
            'profile_aspect': 'judgment_preference',
            'global_title': '注释写清楚功能',
            'global_instruction': '由 AI 开发时，注释要写清楚功能。',
        })
    return value


def candidate_id_for(source_items):
    item_ids = sorted(item['item_id'] for item in source_items)
    digest = hashlib.sha256('\n'.join(item_ids).encode()).hexdigest()[:20]
    return f'personal-global-{digest}'


def candidate_version_for(snapshots, eligible_target_scopes=None):
    source_state = [{
        'item_id': item['item_id'],
        'item_kind': item['item_kind'],
        'project_id': item['project_id'],
        'key': item['key'],
        'preference_key': item['preference_key'],
        'preference_qualifiers': item.get('preference_qualifiers', {}),
        'title': item['title'],
        'instruction': item['instruction'],
        'profile_aspect': item['profile_aspect'],
        'confirmation_status': item['confirmation_status'],
        'confirmation_basis': source_confirmation_basis(item),
        'stored_confirmation_basis_json': source_confirmation_basis_json(item),
        'stored_attributes_json': source_attributes_json(item),
        'human_change_version': item['human_change_version'],
        'usage_generation': item['usage_generation'],
        'last_human_changed_at': item['last_human_changed_at'],
        'negative_evidence_count': item.get('negative_evidence_count', 0),
        'requires_attention': item.get('requires_attention', False),
        'last_feedback_at': item.get('last_feedback_at'),
        'source_uris': sorted(set(item['source_uris'])),
    } for item in sorted(snapshots, key=lambda item: item['item_id'])]
    state = {
        'eligible_target_scopes': eligible_target_scopes or [{
            'target_scope': 'personal_global',
            'target_project_id': None,
            'max_distance': None,
        }],
        'sources': source_state,
    }
    canonical = json.dumps(
        state,
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
    )
    return f'v1:{hashlib.sha256(canonical.encode()).hexdigest()[:24]}'


class ZeroEmbedder:
    async def create(self, _value):
        return [0.0] * 64


class PersonalGlobalDecisionDriver:
    def __init__(self):
        self.sources = {
            'entity-travel-d': source_snapshot(
                'entity-travel-d',
                'travel-d',
                'alignment:network:preference:d',
                '这个项目由 AI 开发时，注释要写清楚功能。',
                'https://fixtures.invalid/travel-d/preference',
            ),
            'entity-preference-e': source_snapshot(
                'entity-preference-e',
                'preference-e',
                'alignment:network:preference:e',
                '这个项目由 AI 开发时，注释要用中文写清楚功能。',
                'https://fixtures.invalid/preference-e/preference',
            ),
        }
        self.previews = {}
        self.events = []
        self.events_by_id = {}
        self.decisions = {}
        self.assertions = {}
        self.applied_count = 0
        self.common_parent_rows = []
        self.mutate_parents_before_apply = None
        self.mutate_source_before_apply = None

    def source_snapshots(self, refs):
        return [dict(self.sources[ref['item_id']]) for ref in refs]

    async def execute_query(self, query, **parameters):
        if 'fuli:personal-global-source-entities' in query:
            rows = [
                self._source_row(source)
                for source in parameters['sources']
                if source['item_id'] in self.sources
            ]
            return rows, None, None
        if 'fuli:personal-global-eligible-parent-scopes' in query:
            return [dict(row) for row in self.common_parent_rows], None, None
        if 'fuli:create-personal-global-decision-preview' in query:
            decision = self.decisions.get(parameters['candidate_id'])
            current_revision = decision['decision_revision'] if decision else 0
            if current_revision != parameters['decision_revision']:
                return [], None, None
            self.previews[parameters['token_hash']] = {
                **parameters,
                'used': False,
            }
            return [{'preview_id': parameters['preview_id']}], None, None
        if 'fuli:personal-global-decision-event' in query:
            event = self.events_by_id.get(parameters['event_id'])
            if not event:
                return [], None, None
            current = self.decisions.get(event['candidate_id'])
            assertion = self.assertions.get(event.get('global_assertion_id'))
            return [{
                **event,
                'global_assertion_active': bool(
                    current
                    and current['decision_event_id'] == event['decision_event_id']
                    and assertion
                    and assertion['active']
                ),
            }], None, None
        if 'fuli:apply-personal-global-decision' in query:
            preview = self.previews.get(parameters['token_hash'])
            if (
                not preview
                or preview['used']
                or preview['payload_fingerprint'] != parameters['payload_fingerprint']
                or preview['issued_to_actor_id'] != parameters['actor_id']
            ):
                return [], None, None
            if self.mutate_parents_before_apply:
                mutation = self.mutate_parents_before_apply
                self.mutate_parents_before_apply = None
                mutation(self)
            if self.mutate_source_before_apply:
                mutation = self.mutate_source_before_apply
                self.mutate_source_before_apply = None
                mutation(self)
            expected_scope_options = [
                {
                    'target_scope': 'parent_project',
                    'target_project_id': row['target_project_id'],
                    'max_distance': row['max_distance'],
                }
                for row in parameters['expected_parent_scopes']
            ] + [{
                'target_scope': 'personal_global',
                'target_project_id': None,
                'max_distance': None,
            }]
            current_version = candidate_version_for(
                self.source_snapshots(parameters['source_items']),
                expected_scope_options,
            )
            if current_version != parameters['candidate_version']:
                return [], None, None
            current_parent_scopes = [
                {
                    'target_project_id': row['target_project_id'],
                    'max_distance': row['max_distance'],
                }
                for row in self.common_parent_rows
            ]
            if current_parent_scopes != parameters['expected_parent_scopes']:
                return [], None, None
            current = self.decisions.get(parameters['candidate_id'])
            current_revision = current['decision_revision'] if current else 0
            if current_revision != parameters['decision_revision']:
                return [], None, None
            preview['used'] = True
            previous = self.decisions.get(parameters['candidate_id'])
            if previous and previous.get('global_assertion_id'):
                self.assertions[previous['global_assertion_id']]['active'] = False
            assertion_id = parameters['global_assertion_id']
            if assertion_id:
                self.assertions[assertion_id] = {
                    'active': True,
                    'preference_scope': parameters['preference_scope'],
                    'preference_project_id': parameters[
                        'preference_project_id'
                    ],
                    'inheritance_mode': parameters['inheritance_mode'],
                }
            event = {
                'decision_event_id': parameters['event_id'],
                'payload_fingerprint': parameters['payload_fingerprint'],
                'candidate_id': parameters['candidate_id'],
                'candidate_version': parameters['candidate_version'],
                'decision_revision': parameters['decision_revision'] + 1,
                'decision': parameters['decision_status'],
                'target_scope': parameters['target_scope'],
                'target_project_id': parameters['target_project_id'],
                'global_assertion_id': assertion_id,
                'global_assertion_active': assertion_id is not None,
                'decision_sequence': len(self.events) + 1,
                'decided_at': parameters['confirmed_at'],
                'human_confirmation_reason': parameters[
                    'human_confirmation_reason'
                ],
            }
            self.events.append(event)
            self.events_by_id[parameters['event_id']] = event
            self.decisions[parameters['candidate_id']] = event
            self.applied_count += 1
            return [event], None, None
        if 'fuli:personal-global-decision-status' in query:
            rows = []
            for requested in parameters['candidates']:
                value = self.decisions.get(requested['candidate_id'])
                rows.append({
                    **(value or {}),
                    'decision_event_id': (
                        value['decision_event_id'] if value else None
                    ),
                    'candidate_id': requested['candidate_id'],
                    'candidate_version': requested['candidate_version'],
                    'requested_candidate_version': requested['candidate_version'],
                    'current_candidate_version': (
                        value['candidate_version'] if value else None
                    ),
                    'decision_revision': (
                        value['decision_revision'] if value else 0
                    ),
                })
            return rows, None, None
        raise AssertionError(f'Unexpected query: {query[:120]}')

    def _source_row(self, source):
        snapshot = self.sources[source['item_id']]
        return {
            **snapshot,
            'attributes_json': source_attributes_json(snapshot),
            'confirmation_basis_json': source_confirmation_basis_json(snapshot),
        }

    def eligible_target_scopes(self):
        return [
            {
                'target_scope': 'parent_project',
                'target_project_id': row['target_project_id'],
                'max_distance': row['max_distance'],
            }
            for row in self.common_parent_rows
        ] + [{
            'target_scope': 'personal_global',
            'target_project_id': None,
            'max_distance': None,
        }]


def source_snapshot(item_id, project_id, key, instruction, source_uri):
    return {
        'item_id': item_id,
        'item_kind': 'entity',
        'project_id': project_id,
        'key': key,
        'preference_key': 'alignment.comments.explain-function',
        'preference_qualifiers': {
            'audience': 'project contributors',
        },
        'title': f'{project_id} 注释偏好',
        'instruction': instruction,
        'profile_aspect': 'judgment_preference',
        'confirmation_status': 'confirmed',
        'confirmation_basis': confirmation_basis(),
        'human_change_version': 0,
        'usage_generation': 1,
        'last_human_changed_at': None,
        'source_uris': [source_uri],
    }


def confirmation_basis():
    return {
        'existence_reason': '用户明确表达。',
        'quadrant_reason': '偏好直接确认。',
        'proposed_by': {'kind': 'user', 'label': '用户'},
        'confirmed_by': {'kind': 'user', 'label': '用户'},
        'confirmed_at': '2026-08-03T00:00:00Z',
        'agent_policy_version': None,
    }


def confirmation_basis_json():
    return json.dumps(confirmation_basis(), ensure_ascii=False)


def source_confirmation_basis(snapshot):
    return snapshot.get('confirmation_basis') or confirmation_basis()


def source_confirmation_basis_json(snapshot):
    return json.dumps(source_confirmation_basis(snapshot), ensure_ascii=False)


def source_attributes_json(snapshot):
    return json.dumps({
        'preferenceKey': snapshot['preference_key'],
        **snapshot.get('preference_qualifiers', {}),
    }, ensure_ascii=False)


def async_value(value):
    async def resolve(*_args, **_kwargs):
        return value

    return resolve
