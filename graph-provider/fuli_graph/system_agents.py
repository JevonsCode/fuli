"""Fixed roles: Jefa, Bole, Tonborg, and the global task-only Assistant.

Jefa also coordinates task routing, replacing the earlier separate coordinator
identity. That legacy node is retired, not deleted, so old tasks keep their
original coordinator reference.
"""

import json

from .occupation_catalog import BUILTIN_AGENT_OCCUPATIONS
from .project_agent_models import ProjectAgentProfile
from .project_agent_employee_numbers import ASSIGN_EMPLOYEE_NUMBERS, EMPLOYEE_NUMBER_LOCK
from .provider_values import now_utc, stable_uuid

SYSTEM_COORDINATOR_AGENT_ID = 'employee.jefa'
LEGACY_COORDINATOR_AGENT_ID = 'fuli-project-coordinator'
SYSTEM_HR_AGENT_ID = 'employee.bole'
SYSTEM_JUDGMENT_AGENT_ID = 'employee.tonborg'
SYSTEM_ASSISTANT_AGENT_ID = 'employee.assistant'
# Upgrade only the former built-in copy; custom responsibilities are user data.
LEGACY_ASSISTANT_NAME = 'Assistant'
# Earlier built-in Bole copies, upgraded in place; any other text is the user's.
LEGACY_HR_RESPONSIBILITIES = (
    'HR：维护 Agent 人员分布与工作状态，按需招募并保留招募记录。',
    'AR：维护 Agent 人员分布与工作状态，按需招募并保留招募记录。',
)
LEGACY_JUDGMENT_RESPONSIBILITY = '判断官：依照用户偏好审核日常事项、建议客户端和模型，保留判断依据与反馈。'


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
        responsibility=(
            'AR：维护 Agent 人员分布与工作状态，按需招募并保留招募记录；'
            '在用户发起或同意时办理离职：先问理由，沉淀教训并留下交接。'
        ),
        agent_type='hr',
        work_kinds=['agent-recruitment', 'staffing-review', 'agent-dismissal'],
        capabilities=['Agent 招募', '人员分布', '工作状态', '招募审计', 'Agent 离职', 'fuli.employee:bole'],
        initial_preferences=[
            '每次招募保留任务、原因、触发来源与时间线。',
            '只展示 Provider 已记录的人员状态，不推测未上报的工作。',
            '不自己决定开除谁；没有用户给出的理由不办理离职。',
        ],
        status='active',
    )


def judgment_profile() -> ProjectAgentProfile:
    return ProjectAgentProfile(
        name='Tonborg',
        occupation_emoji='⚖️',
        responsibility='决策员：依照用户偏好审核日常事项、建议客户端和模型，保留判断依据与反馈。',
        agent_type='durable',
        work_kinds=['judgment', 'knowledge-review', 'executor-selection'],
        capabilities=['判断审核', '执行器选择', '判断反馈', 'fuli.employee:tonborg'],
        initial_preferences=[
            '用户明确偏好优先；只把相关范围的历史反馈用于当前判断。',
            '不把模型建议当作已执行，不把 AI 审核冒充用户确认。',
            '保持项目总负责人与汇报关系。',
        ],
        status='active',
    )


def assistant_profile() -> ProjectAgentProfile:
    return ProjectAgentProfile(
        # A person's name, like Jefa, Bole and Tonborg; 'assistant' is the occupation.
        name='Astro', occupation_emoji='💬',
        responsibility='全局助手：接待未归属项目的对话，只用全局偏好，不自动询问项目归属。',
        work_kinds=['conversation'],
        capabilities=['全局对话', 'fuli.employee:assistant'],
        initial_preferences=['项目确认前只保留任务上下文，不写入长期记忆。'],
    )


SYSTEM_PROFILES = {
    SYSTEM_COORDINATOR_AGENT_ID: coordinator_profile,
    SYSTEM_HR_AGENT_ID: hr_profile,
    SYSTEM_JUDGMENT_AGENT_ID: judgment_profile,
    SYSTEM_ASSISTANT_AGENT_ID: assistant_profile,
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
    upgrade_responsibility = False
    if rows and rows[0]['profile_json']:
        stored = json.loads(rows[0]['profile_json'])
        upgrade_responsibility = (
            (agent_id == SYSTEM_HR_AGENT_ID
             and stored.get('responsibility') in LEGACY_HR_RESPONSIBILITIES)
            or (agent_id == SYSTEM_JUDGMENT_AGENT_ID
                and stored.get('responsibility') == LEGACY_JUDGMENT_RESPONSIBILITY)
        )
        if upgrade_responsibility:
            stored['responsibility'] = default.responsibility
        # The assistant was first created as "Assistant"; the built-in name is
        # now Astro. Only the untouched old default is renamed, never a user's name.
        if agent_id == SYSTEM_ASSISTANT_AGENT_ID:
            for field in ('name', 'display_name'):
                if stored.get(field) == LEGACY_ASSISTANT_NAME:
                    stored[field] = default.name
        profile = ProjectAgentProfile.model_validate(
            {**stored, 'agent_type': default.agent_type, 'status': 'active'}
        )
    now = now_utc()
    await driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        ''' + EMPLOYEE_NUMBER_LOCK + '''
        MERGE (agent:FuliProjectAgent {id: $id})
        ON CREATE SET agent.agent_id = $agent_id,
                      agent.name = $name,
                      agent.occupation_emoji = $occupation_emoji,
                      agent.responsibility = $responsibility,
                      agent.capabilities = $capabilities,
                      agent.work_kinds = $work_kinds,
                      agent.memory_scope = $memory_scope,
                      agent.created_at = $now,
                      agent.updated_at = $now
        SET agent.profile_json = $profile_json,
            agent.name = CASE WHEN agent.name = $legacy_name THEN $name ELSE agent.name END,
            agent.responsibility = CASE WHEN $upgrade_responsibility
              THEN $responsibility ELSE agent.responsibility END,
            agent.agent_type = $agent_type,
            agent.status = 'active',
            agent.system_managed = true,
            agent.memory_scope = $memory_scope
        FOREACH (_ IN CASE WHEN agent.occupation_role IS NULL THEN [1] ELSE [] END |
          SET agent.occupation_role = $occupation_role,
              agent.occupation_tags = coalesce(agent.occupation_tags, []),
              agent.occupation_updated_at = $now,
              agent.occupation_source = 'builtin-role-v1'
        )
        MERGE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(agent)
        ''' + ASSIGN_EMPLOYEE_NUMBERS + ' RETURN agent',
        space_id=space_id,
        id=node_id,
        agent_id=agent_id,
        profile_json=profile.model_dump_json(),
        name=profile.name,
        occupation_emoji=profile.occupation_emoji,
        responsibility=profile.responsibility,
        upgrade_responsibility=upgrade_responsibility,
        legacy_name=LEGACY_ASSISTANT_NAME if agent_id == SYSTEM_ASSISTANT_AGENT_ID else None,
        capabilities=profile.capabilities,
        work_kinds=profile.work_kinds,
        agent_type=profile.agent_type,
        memory_scope='task_only' if agent_id == SYSTEM_ASSISTANT_AGENT_ID else 'reviewed_agent',
        occupation_role=BUILTIN_AGENT_OCCUPATIONS[agent_id],
        now=now,
    )
    if agent_id == SYSTEM_JUDGMENT_AGENT_ID:
        # Active project duties may still contain the former built-in copy.
        # Keep custom duties and ended assignments as the user recorded them.
        await driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-
                  [:CONTAINS_PROJECT]->(:FuliPersonalProject)-
                  [:HAS_PROJECT_AGENT_ASSIGNMENT]->(assignment:FuliProjectAgentAssignment)-
                  [:ASSIGNED_AGENT]->(:FuliProjectAgent {id: $id})
            WHERE assignment.status = 'active'
              AND assignment.responsibility = $legacy_responsibility
            SET assignment.responsibility = $responsibility,
                assignment.revision = coalesce(assignment.revision, 0) + 1,
                assignment.updated_at = $now
            ''',
            space_id=space_id, id=node_id,
            legacy_responsibility=LEGACY_JUDGMENT_RESPONSIBILITY,
            responsibility=default.responsibility, now=now,
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
