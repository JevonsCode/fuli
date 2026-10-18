from types import SimpleNamespace
from datetime import UTC, datetime
import json

import pytest
from fastapi import HTTPException

from fuli_graph.project_agent_hierarchy import validate_worker_reporting


POLICY = {'team_lead_agent_id': 'root', 'team_member_agent_ids': ['sub', 'member'],
    'updated_at': datetime(2026, 10, 18, tzinfo=UTC), 'sub_teams_json': json.dumps([
        {'id': 'one', 'name': 'One', 'lead_agent_id': 'sub', 'member_agent_ids': ['member']}])}
SCOPE = SimpleNamespace(personal_space_id='space', personal_project_id='project')


def test_worker_authority_binds_and_rechecks_the_current_hierarchy_version():
    run = {}
    task = {'coordinator_agent_id': 'sub', 'lead_agent_id': 'member'}
    validate_worker_reporting(POLICY, SCOPE, run, task, 'sub', 'member')
    assert run['hierarchy_policy_version']
    run['id'] = 'run'
    validate_worker_reporting(POLICY, SCOPE, run, task, 'sub', 'member')
    for changed in [{**POLICY, 'updated_at': datetime(2026, 10, 19, tzinfo=UTC)},
                    {**POLICY, 'sub_teams_json': '[]'}]:
        with pytest.raises(HTTPException):
            validate_worker_reporting(changed, SCOPE, run, task, 'sub', 'member')


def test_legacy_workers_cannot_be_reused_after_grouping_or_skip_a_level():
    task = {'coordinator_agent_id': 'root', 'lead_agent_id': 'member'}
    with pytest.raises(HTTPException):
        validate_worker_reporting(POLICY, SCOPE, {'id': 'legacy-run'}, task, 'root', 'member')
    with pytest.raises(HTTPException):
        validate_worker_reporting(POLICY, SCOPE, {}, task, 'root', 'member')
    # Flat legacy behavior remains unchanged.
    validate_worker_reporting({}, SCOPE, {'id': 'legacy-run'}, task, 'root', 'member')
