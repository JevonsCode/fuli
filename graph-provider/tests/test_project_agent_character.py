"""Role traits are configured intent, never evidence of observed growth."""

import json

import pytest
from pydantic import ValidationError

from fuli_graph.project_agent_models import ProjectAgentProfile, ProjectAgentUpsert
from fuli_graph.store_project_agent_task_recruitment import StoreProjectAgentTaskRecruitment
from test_project_agent_tasks import task_request
from test_project_agents import SequentialDriver, StoreStub, raw_agent


def profile_payload(**changes):
    return {
        'name': 'Synthetic reviewer', 'display_name': 'Synthetic role',
        'responsibility': 'Review synthetic changes.',
        'character': {'judgment': 'Check evidence first.', 'taste': 'Prefer clear layouts.',
                      'personality': 'Patient and direct.'},
        'expectations': 'Explain tradeoffs before changing scope.',
        'default_model_strategy': {'mode': 'deep'},
        'executor_policy': {'mode': 'locked', 'locked_executor_ids': ['synthetic-executor']},
        'allowed_clients': ['codex'], 'initial_preferences': ['Keep summaries concise.'],
        **changes,
    }


def test_legacy_profile_defaults_and_partial_character_are_compatible():
    legacy = ProjectAgentProfile(name='Synthetic reviewer', responsibility='Review changes.')
    assert legacy.character.model_dump() == {'judgment': '', 'taste': '', 'personality': ''}
    assert legacy.expectations == ''
    partial = ProjectAgentProfile(**profile_payload(character={'taste': 'Clear structure.'}))
    assert partial.character.judgment == ''
    assert partial.character.taste == 'Clear structure.'


@pytest.mark.parametrize('field', ['judgment', 'taste', 'personality', 'expectations'])
def test_character_and_expectations_enforce_bounds_and_reject_credentials(field):
    limit = 4096 if field == 'expectations' else 2048
    for value in ('x' * (limit + 1), 'api_key=synthetic-test-secret'):
        payload = profile_payload()
        if field == 'expectations':
            payload[field] = value
        else:
            payload['character'][field] = value
        with pytest.raises(ValidationError):
            ProjectAgentProfile(**payload)
    payload = profile_payload()
    if field == 'expectations':
        payload[field] = 'x' * limit
    else:
        payload['character'][field] = 'x' * limit
    ProjectAgentProfile(**payload)


@pytest.mark.asyncio
async def test_profile_update_serializes_and_reads_traits_without_dropping_settings():
    original = ProjectAgentProfile(**profile_payload())
    payload = original.model_dump()
    payload['character']['judgment'] = 'Verify claims against recorded evidence.'
    payload['expectations'] = 'Ask before expanding scope.'
    updated = ProjectAgentProfile(**payload)
    raw = raw_agent(updated)
    driver = SequentialDriver([
        [{'agent': raw}],
        [{'agent': raw, 'assignment_rows': [], 'task_rows': [], 'observed_clients': []}],
    ])
    result = await StoreStub(driver).upsert_project_agent(
        {'id': 'principal-1'}, ProjectAgentUpsert(
            personal_space_id='personal-space', agent_id='activity-agent', profile=updated))
    persisted = json.loads(driver.calls[0][1]['profile_json'])
    assert persisted == updated.model_dump(mode='json')
    assert result.profile == updated
    assert result.profile.executor_policy == original.executor_policy
    assert result.profile.default_model_strategy == original.default_model_strategy
    assert result.profile.allowed_clients == original.allowed_clients
    assert result.profile.initial_preferences == original.initial_preferences


def test_hr_recruitment_normalization_preserves_declared_character_and_expectations():
    profile = ProjectAgentProfile(**profile_payload())
    request = task_request(staffing_intent='new_durable', recruitment_profile=profile)
    kind, normalized = StoreProjectAgentTaskRecruitment._normalized_recruitment_profile(request)
    assert kind == 'durable'
    assert normalized == profile
    schema = ProjectAgentUpsert.model_json_schema()
    profile_schema = schema['$defs']['ProjectAgentProfile']
    assert 'character' in profile_schema['properties']
    assert 'expectations' in profile_schema['properties']
    assert 'character' not in profile_schema['required']
    assert 'expectations' not in profile_schema['required']
