"""Atomic recruitment fulfillment with occupation and task-lifecycle guards."""

from .provider_values import now_utc
from .occupation_catalog import BUILTIN_OCCUPATION_KEYS
from .store_occupation_catalog import OCCUPATION_LOCK, active_occupation_predicate


class StoreRecruitmentFulfillment:
    async def _finalize_ready_recruitment(
        self,
        request,
        recruitment_id,
        *,
        task_id=None,
        expected_task_revision=None,
    ):
        updated_at = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {
              id: $personal_space_id, kind: 'personal'
            })-[:HAS_PROJECT_AGENT_RECRUITMENT]->
                  (recruitment:FuliProjectAgentRecruitment {
                    recruitment_id: $recruitment_id,
                    status: 'requested'
                  })
            ''' + OCCUPATION_LOCK + '''
            OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_TASK]->
                  (task:FuliProjectAgentTask {task_id: $task_id})
            FOREACH (_ IN CASE WHEN task IS NULL THEN [] ELSE [1] END |
              SET task._task_lifecycle_lock = true
            )
            FOREACH (_ IN CASE WHEN task IS NULL THEN [] ELSE [1] END |
              REMOVE task._task_lifecycle_lock
            )
            WITH space, recruitment, task
            MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->
                  (agent:FuliProjectAgent)
            WHERE agent.agent_id = recruitment.proposed_agent_id
            SET agent._task_lifecycle_lock = true
            REMOVE agent._task_lifecycle_lock
            WITH space, recruitment, agent, task
            WHERE agent.status = 'active' AND recruitment.occupation_role IS NOT NULL
              AND recruitment.occupation_role <> 'assistant'
              AND ''' + active_occupation_predicate('[recruitment.occupation_role] + coalesce(recruitment.occupation_tags, [])') + '''
            MATCH (space)-[:CONTAINS_PROJECT]->
                  (:FuliPersonalProject {project_id: $personal_project_id})-
                  [:HAS_PROJECT_AGENT_ASSIGNMENT]->
                  (:FuliProjectAgentAssignment {status: 'active'})-
                  [:ASSIGNED_AGENT]->(agent)
            WITH recruitment, agent, task
            WHERE $task_id IS NULL
               OR (
                 recruitment.task_id = $task_id
                 AND task.status = 'awaiting_recruitment'
                 AND coalesce(task.revision, 0) = $expected_task_revision
               )
            SET recruitment.status = 'fulfilled',
                recruitment.recruited_agent_id = agent.agent_id,
                recruitment.fulfilled_at = $updated_at,
                recruitment.updated_at = $updated_at,
                recruitment.revision = coalesce(recruitment.revision, 0) + 1,
                agent.occupation_role = recruitment.occupation_role,
                agent.occupation_tags = coalesce(recruitment.occupation_tags, []),
                agent.occupation_updated_at = $updated_at,
                agent.occupation_recruitment_id = recruitment.recruitment_id,
                agent.recruitment_id = recruitment.recruitment_id,
                agent.recruited_at = coalesce(agent.recruited_at, $updated_at),
                agent.recruitment_reason = recruitment.reason,
                agent.recruitment_source_application =
                  recruitment.trigger_source_application,
                agent.temporary_task_id = CASE recruitment.position_kind
                  WHEN 'temporary' THEN recruitment.task_id
                  ELSE agent.temporary_task_id END,
                agent.test_source = recruitment.test_source,
                agent.cleanup_eligible =
                  coalesce(recruitment.cleanup_eligible, false)
            FOREACH (_ IN CASE WHEN $task_id IS NULL THEN [] ELSE [1] END |
              SET task.recruitment_provisioning_claim_id = null,
                  task.recruitment_provisioning_claimed_at = null,
                  task.revision = coalesce(task.revision, 0) + 1,
                  task.updated_at = $updated_at
            )
            MERGE (recruitment)-[:CREATED_AGENT]->(agent)
            RETURN recruitment
            ''',
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            recruitment_id=recruitment_id,
            task_id=task_id,
            expected_task_revision=expected_task_revision,
            builtin_occupation_keys=BUILTIN_OCCUPATION_KEYS,
            updated_at=updated_at,
        )
        return dict(records[0]['recruitment']) if records else None
