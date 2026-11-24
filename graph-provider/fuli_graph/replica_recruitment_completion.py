"""A recruitment of this computer's own project finishes once the copy of
`global` brings the FLA its owner made for it (docs/runner-roles-design.md
§12; global_replica.RECRUITMENT_ON_OWNER).

While `global` is a copy here, the roster is the owner's: a recruitment waits
as 'blocked' / recruitment_on_owner, the owner makes the FLA under the
recruitment's proposed agent_id (owner_hire.py), and the next import of
`global` brings it. Then, after that import committed, each waiting
recruitment whose FLA arrived is finished here as a single computer finishes
an automatic hire (store_project_agent_task_recruitment.py), with this
computer's own records only: the project assignment (the same idempotency key),
the recruitment fulfilled, the lead in the project team, the task queued. The
FLA itself is the owner's copy: nothing here sets a property on it; what a
single computer writes on its FLA at a hire, the owner wrote when it made it.

A failure is logged and counted, never the import's: the next import tries again.
"""
import logging

from .default_project_lead import close_default_lead_task
from .global_replica import RECRUITMENT_ON_OWNER
from .project_agent_models import ProjectAgentAssignmentCreate
from .project_agent_recruitment_values import project_agent_recruitment_profile
from .project_agent_team_growth import enroll_recruited_team_member
from .provider_values import now_utc
from .store_transactions import query_store_transaction

logger = logging.getLogger(__name__)

ACTIVATION_REASON = 'The FLA the owner of global made for this recruitment arrived with its copy.'


async def complete_owner_recruitments(store, actor, personal_space_id: str) -> dict:
    """What the import answers about the recruitments waiting for the owner:
    finished now, still waiting for their FLA, failed (tried again next import)."""
    counts = {'recruitmentsCompleted': 0, 'recruitmentsPending': 0, 'recruitmentsFailed': 0}
    try:
        waiting = await _waiting(store, personal_space_id)
    except Exception:
        logger.exception('could not read the recruitments waiting for the owner of global')
        counts['recruitmentsFailed'] = 1
        return counts
    for recruitment_id, arrived in waiting:
        if not arrived:
            counts['recruitmentsPending'] += 1
            continue
        try:
            done = await _complete(store, actor, personal_space_id, recruitment_id)
        except Exception:
            logger.exception('recruitment %s could not be finished after its FLA arrived', recruitment_id)
            counts['recruitmentsFailed'] += 1
            continue
        counts['recruitmentsCompleted' if done else 'recruitmentsPending'] += 1
    return counts


async def _waiting(store, personal_space_id):
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
              [:HAS_PROJECT_AGENT_RECRUITMENT]->
              (recruitment:FuliProjectAgentRecruitment {status: 'blocked', reason_code: $on_owner})
        OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
              (agent:FuliProjectAgent {agent_id: recruitment.proposed_agent_id})
        RETURN recruitment.recruitment_id AS recruitment_id,
               coalesce(agent.fuli_replica_owner IS NOT NULL AND agent.status = 'active'
                        AND agent.recruitment_id = recruitment.recruitment_id, false) AS arrived
        ORDER BY recruitment.created_at, recruitment.recruitment_id
        ''',
        personal_space_id=personal_space_id, on_owner=RECRUITMENT_ON_OWNER, routing_='r',
    )
    return [(row['recruitment_id'], row['arrived']) for row in records]


async def _complete(store, actor, personal_space_id, recruitment_id) -> bool:
    # Assignment, fulfillment and team in one transaction, as a single computer's
    # provisioning; the task's activation after it, as after an approval.
    async with query_store_transaction(store) as scoped:
        raw = await _fulfilled(scoped, personal_space_id, recruitment_id)
        if raw is None:
            return False  # finished or cancelled meanwhile
        profile = project_agent_recruitment_profile(raw)
        agent_id = raw['proposed_agent_id']
        await scoped.create_project_agent_assignment(actor, ProjectAgentAssignmentCreate(
            personal_space_id=personal_space_id,
            personal_project_id=raw['personal_project_id'],
            agent_id=agent_id,
            idempotency_key=f"recruit:{recruitment_id}",
            responsibility=profile.responsibility,
            work_kinds=profile.work_kinds or [raw['work_kind']],
            capabilities=profile.capabilities,
            reason=raw['reason'],
            source_application=raw.get('trigger_source_application'),
            source_session_id=raw.get('trigger_source_session_id'),
        ))
        candidates = await scoped._assignment_candidates(
            personal_space_id, raw['personal_project_id'], include_temporary=True)
        selected = next(item for item in candidates if item['agent_id'] == agent_id)
        await enroll_recruited_team_member(scoped, raw, profile)
    await store._activate_approved_recruitment(actor, raw, selected, ACTIVATION_REASON)
    row = await store._find_task_row(personal_space_id, raw['task_id'])
    task = store._task_from_row(row) if row else None
    if task and task.staffing_intent == 'default_lead' and task.lead_agent_id == agent_id:
        lead = await store.get_project_agent(actor, personal_space_id, raw['personal_project_id'], agent_id)
        await close_default_lead_task(store, actor, task, lead, f'owner-hire:{recruitment_id}')
    return True


async def _fulfilled(scoped, personal_space_id, recruitment_id) -> dict | None:
    """The waiting recruitment, fulfilled by its arrived FLA; None when it no
    longer waits. Its routing reason, which the wait stood in for, comes back
    from its task: from here on it reads as any automatic hire."""
    updated_at = now_utc()
    records, _, _ = await scoped.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
              [:HAS_PROJECT_AGENT_RECRUITMENT]->
              (recruitment:FuliProjectAgentRecruitment {recruitment_id: $recruitment_id})
        SET recruitment._provision_write_lock = true
        REMOVE recruitment._provision_write_lock
        WITH space, recruitment
        WHERE recruitment.status = 'blocked' AND recruitment.reason_code = $on_owner
        MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
              (agent:FuliProjectAgent {agent_id: recruitment.proposed_agent_id})
        WHERE agent.status = 'active' AND agent.fuli_replica_owner IS NOT NULL
          AND agent.recruitment_id = recruitment.recruitment_id
        OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->
              (task:FuliProjectAgentTask {task_id: recruitment.task_id})
        SET recruitment.status = 'fulfilled',
            recruitment.reason_code = coalesce(task.routing_reason, 'no_match'),
            recruitment.recruited_agent_id = agent.agent_id,
            recruitment.fulfilled_at = $updated_at,
            recruitment.updated_at = $updated_at,
            recruitment.revision = coalesce(recruitment.revision, 0) + 1
        MERGE (recruitment)-[:CREATED_AGENT]->(agent)
        RETURN recruitment
        ''',
        personal_space_id=personal_space_id, recruitment_id=recruitment_id,
        on_owner=RECRUITMENT_ON_OWNER, updated_at=updated_at,
    )
    return dict(records[0]['recruitment']) if records else None
