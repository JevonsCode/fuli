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
    for recruitment_id, ready in waiting:
        if not ready:
            counts['recruitmentsPending'] += 1
            continue
        try:
            done = await _complete(store, actor, personal_space_id, recruitment_id)
        except Exception:
            logger.exception('recruitment %s could not be finished after its FLA arrived', recruitment_id)
            counts['recruitmentsFailed'] += 1
            continue
        if done:
            counts['recruitmentsCompleted'] += 1
    return counts


async def _waiting(store, personal_space_id):
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
              [:HAS_PROJECT_AGENT_RECRUITMENT]->
              (recruitment:FuliProjectAgentRecruitment)
        WHERE recruitment.fuli_replica_owner IS NULL AND
              ((recruitment.status = 'blocked' AND recruitment.reason_code = $on_owner)
               OR recruitment.status = 'fulfilled')
        OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->(task:FuliProjectAgentTask {task_id: recruitment.task_id})
        OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
              (agent:FuliProjectAgent {agent_id: recruitment.proposed_agent_id})
        WITH recruitment, task, agent
        WHERE recruitment.status = 'blocked'
           OR (recruitment.status = 'fulfilled' AND agent.fuli_replica_owner IS NOT NULL
               AND agent.recruitment_id = recruitment.recruitment_id AND
               (task.status = 'awaiting_recruitment' OR
                (task.staffing_intent = 'default_lead' AND task.status IN ['queued', 'running'])))
        RETURN recruitment.recruitment_id AS recruitment_id,
               task IS NOT NULL AND (task.status <> 'awaiting_recruitment' OR
                 coalesce(agent.fuli_replica_owner IS NOT NULL AND agent.status = 'active'
                          AND agent.recruitment_id = recruitment.recruitment_id, false)) AS ready
        ORDER BY recruitment.created_at, recruitment.recruitment_id
        ''',
        personal_space_id=personal_space_id, on_owner=RECRUITMENT_ON_OWNER, routing_='r',
    )
    return [(row['recruitment_id'], row['ready']) for row in records]


async def _complete(store, actor, personal_space_id, recruitment_id) -> bool:
    # Assignment, fulfillment and team in one transaction, as a single computer's
    # provisioning; the task's activation after it, as after an approval.
    async with query_store_transaction(store) as scoped:
        raw, newly_fulfilled = await _fulfilled(scoped, personal_space_id, recruitment_id)
        if raw is None:
            return False  # finished or cancelled meanwhile
        profile = project_agent_recruitment_profile(raw)
        agent_id = raw['proposed_agent_id']
        if newly_fulfilled:
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
            await enroll_recruited_team_member(scoped, raw, profile)
        candidates = await scoped._assignment_candidates(
            personal_space_id, raw['personal_project_id'], include_temporary=True)
        selected = next(item for item in candidates if item['agent_id'] == agent_id)
    await store._activate_approved_recruitment(actor, raw, selected, ACTIVATION_REASON)
    row = await store._find_task_row(personal_space_id, raw['task_id'])
    task = store._task_from_row(row) if row else None
    if task and task.staffing_intent == 'default_lead' and task.lead_agent_id == agent_id:
        lead = await store.get_project_agent(actor, personal_space_id, raw['personal_project_id'], agent_id)
        await close_default_lead_task(store, actor, task, lead, f'owner-hire:{recruitment_id}',
                                      task.source_application or 'other')
    return True


async def _fulfilled(scoped, personal_space_id, recruitment_id):
    """Claim the recruitment and task together. A replay only resumes activation."""
    bindings = dict(personal_space_id=personal_space_id, recruitment_id=recruitment_id,
                    on_owner=RECRUITMENT_ON_OWNER, updated_at=now_utc())
    rows, _, _ = await scoped.runtime.driver.execute_query(
        """
        MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-[:HAS_PROJECT_AGENT_RECRUITMENT]->
              (r:FuliProjectAgentRecruitment {recruitment_id: $recruitment_id})
        MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->(t:FuliProjectAgentTask {task_id: r.task_id})
        WITH space, r, t, coalesce(t.revision, 0) AS expected_revision
        SET t._task_lifecycle_lock = true REMOVE t._task_lifecycle_lock
        SET r._provision_write_lock = true REMOVE r._provision_write_lock
        WITH space, r, t, expected_revision
        WHERE r.fuli_replica_owner IS NULL AND coalesce(t.revision, 0) = expected_revision
        OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(a:FuliProjectAgent {agent_id: r.proposed_agent_id})
        WHERE a.status = 'active' AND a.fuli_replica_owner IS NOT NULL AND a.recruitment_id = r.recruitment_id
        WITH r, t, a, r.status = 'blocked' AND r.reason_code = $on_owner AS waiting
        WHERE waiting OR (r.status = 'fulfilled' AND a IS NOT NULL AND
              (t.status = 'awaiting_recruitment' OR
               (t.staffing_intent = 'default_lead' AND t.status IN ['queued', 'running'])))
        WITH r, t, a, waiting,
             waiting AND t.status = 'awaiting_recruitment' AND a IS NOT NULL AS fulfill
        FOREACH (_ IN CASE WHEN waiting AND t.status <> 'awaiting_recruitment' THEN [1] ELSE [] END |
          SET r.status = 'cancelled', r.updated_at = $updated_at, r.revision = coalesce(r.revision, 0) + 1)
        FOREACH (_ IN CASE WHEN fulfill THEN [1] ELSE [] END |
          SET r.status = 'fulfilled', r.reason_code = coalesce(t.routing_reason, 'no_match'),
              r.recruited_agent_id = a.agent_id, r.fulfilled_at = $updated_at, r.updated_at = $updated_at,
              r.revision = coalesce(r.revision, 0) + 1, t.revision = coalesce(t.revision, 0) + 1,
              t.updated_at = $updated_at
          MERGE (r)-[:CREATED_AGENT]->(a))
        WITH r, fulfill WHERE r.status = 'fulfilled'
        RETURN r AS recruitment, fulfill AS newly_fulfilled
        """, **bindings)
    if not rows:
        return None, False
    return dict(rows[0]['recruitment']), rows[0]['newly_fulfilled']
