"""Built-in role copy upgrades preserve user-authored responsibilities."""

import json
from unittest.mock import AsyncMock

import pytest

from fuli_graph.system_agents import (
    SYSTEM_JUDGMENT_AGENT_ID,
    ensure_system_identity,
    judgment_profile,
)


@pytest.mark.asyncio
@pytest.mark.parametrize('responsibility, expected, upgraded', [
    ('判断官：依照用户偏好审核日常事项、建议客户端和模型，保留判断依据与反馈。',
     '决策员：依照用户偏好审核日常事项、建议客户端和模型，保留判断依据与反馈。', True),
    ('判断官：这是用户自定义的职责。', '判断官：这是用户自定义的职责。', False),
    ('决策员：依照用户偏好审核日常事项、建议客户端和模型，保留判断依据与反馈。',
     '决策员：依照用户偏好审核日常事项、建议客户端和模型，保留判断依据与反馈。', False),
])
async def test_tonborg_role_copy_upgrade_preserves_custom_profile(responsibility, expected, upgraded):
    profile = judgment_profile().model_dump()
    profile.update(responsibility=responsibility, expectations='Keep the custom expectation.')
    driver = AsyncMock()
    driver.execute_query.side_effect = [
        ([{'profile_json': json.dumps(profile)}], None, None),
        ([], None, None),
        ([], None, None),
    ]

    await ensure_system_identity(driver, 'test-provider', 'test-space', SYSTEM_JUDGMENT_AGENT_ID)

    written = driver.execute_query.call_args_list[1].kwargs
    assert written['responsibility'] == expected
    assert written['upgrade_responsibility'] is upgraded
    assert json.loads(written['profile_json'])['expectations'] == profile['expectations']

    assignment_upgrade = driver.execute_query.call_args.kwargs
    assert assignment_upgrade['legacy_responsibility'].startswith('判断官：依照用户偏好')
    assert assignment_upgrade['responsibility'].startswith('决策员：')
    assert assignment_upgrade['space_id'] == 'test-space'


def test_new_tonborg_uses_decision_specialist_role():
    assert judgment_profile().responsibility.startswith('决策员：')
