"""The two fixed roles every personal space has: Jefa (project manager) and Bole (HR).

Jefa also coordinates task routing, replacing the earlier separate coordinator
identity. That legacy node is retired, not deleted, so old tasks keep their
original coordinator reference.
"""

import json

from .project_agent_models import ProjectAgentProfile
from .provider_values import now_utc, stable_uuid

SYSTEM_COORDINATOR_AGENT_ID = 'employee.jefa'
LEGACY_COORDINATOR_AGENT_ID = 'fuli-project-coordinator'
SYSTEM_HR_AGENT_ID = 'employee.bole'


def coordinator_profile() -> ProjectAgentProfile:
    return ProjectAgentProfile(
        name='Jefa',
        occupation_emoji='🧭',
        responsibility='项目经理：拆解目标、维护看板与进展，并为任务选择合适的 Agent。',
        agent_type='coordinator',
        work_kinds=['project_management', 'planning', 'review', 'task-coordination'],
        capabilities=['项目规划', '任务拆解', '看板读写', 'Agent 路由', 'fuli.employee:jefa'],
        initial_preferences=[
            '质量与可验收完成优先于成本和时间。',
            'Agent 认为完成时只移入待确认，最终完成由用户决定。',
        ],
        status='active',
    )


def hr_profile() -> ProjectAgentProfile:
    return ProjectAgentProfile(
        name='Bole',
        occupation_emoji='🔎',
        responsibility='HR：维护 Agent 人员分布与工作状态，按需招募并保留招募记录。',
        agent_type='hr',
        work_kinds=['agent-recruitment', 'staffing-review'],
        capabilities=['Agent 招募', '人员分布', '工作状态', '招募审计', 'fuli.employee:bole'],
        initial_preferences=[
            '每次招募保留任务、原因、触发来源与时间线。',
            '只展示 Provider 已记录的人员状态，不推测未上报的工作。',
        ],
        status='active',
    )


SYSTEM_PROFILES = {
    SYSTEM_COORDINATOR_AGENT_ID: coordinator_profile,
    SYSTEM_HR_AGENT_ID: hr_profile,
}


async def ensure_system_identity(driver, provider_id, space_id, agent_id):
    """Create the fixed role once; an existing identity keeps the user's edits.

    A Jefa recruited before it became a fixed role is adopted in place, keeping
    its profile, assignments, memory and history.
    """
    default = SYSTEM_PROFILES[agent_id]()
    node_id = stable_uuid(provider_id, space_id, 'project-agent', agent_id)
    rows, _, _ = await driver.execute_query(
        'MATCH (agent:FuliProjectAgent {id: $id}) RETURN agent.profile_json AS profile_json',
        id=node_id,
    )
    profile = default
    if rows and rows[0]['profile_json']:
        stored = json.loads(rows[0]['profile_json'])
        profile = ProjectAgentProfile.model_validate(
            {**stored, 'agent_type': default.agent_type, 'status': 'active'}
        )
    now = now_utc()
    await driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        MERGE (agent:FuliProjectAgent {id: $id})
        ON CREATE SET agent.agent_id = $agent_id,
                      agent.name = $name,
                      agent.occupation_emoji = $occupation_emoji,
                      agent.responsibility = $responsibility,
                      agent.capabilities = $capabilities,
                      agent.work_kinds = $work_kinds,
                      agent.memory_scope = 'reviewed_agent',
                      agent.created_at = $now,
                      agent.updated_at = $now
        SET agent.profile_json = $profile_json,
            agent.agent_type = $agent_type,
            agent.status = 'active',
            agent.system_managed = true
        MERGE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(agent)
        ''',
        space_id=space_id,
        id=node_id,
        agent_id=agent_id,
        profile_json=profile.model_dump_json(),
        name=profile.name,
        occupation_emoji=profile.occupation_emoji,
        responsibility=profile.responsibility,
        capabilities=profile.capabilities,
        work_kinds=profile.work_kinds,
        agent_type=profile.agent_type,
        now=now,
    )


async def retire_legacy_coordinator(driver, space_id):
    await driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_IDENTITY]->
              (agent:FuliProjectAgent {agent_id: $legacy_id})
        WHERE agent.status <> 'archived'
        SET agent.status = 'archived',
            agent.superseded_by = $canonical_id,
            agent.updated_at = $now
        ''',
        space_id=space_id,
        legacy_id=LEGACY_COORDINATOR_AGENT_ID,
        canonical_id=SYSTEM_COORDINATOR_AGENT_ID,
        now=now_utc(),
    )


async def ensure_system_agents(driver, provider_id, space_id):
    for agent_id in SYSTEM_PROFILES:
        await ensure_system_identity(driver, provider_id, space_id, agent_id)
    await retire_legacy_coordinator(driver, space_id)
