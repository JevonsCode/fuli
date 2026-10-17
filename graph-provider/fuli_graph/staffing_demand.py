"""Read-only, project-scoped occupational demand from existing durable task history."""
from datetime import timedelta

from pydantic import Field, field_validator

from .models import StrictModel
from .personal_project_access import authorize_personal_project
from .project_agent_occupation_models import ProjectAgentOccupationKey
from .provider_values import now_utc


class StaffingDemandQuery(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    occupations: list[ProjectAgentOccupationKey] = Field(min_length=1, max_length=3)

    @field_validator('occupations')
    @classmethod
    def specialist_roles(cls, roles):
        if len(set(roles)) != len(roles) or any(role in {'lead', 'assistant'} for role in roles):
            raise ValueError('demand requires distinct specialist occupations')
        return roles


async def query_staffing_demand(store, actor, request):
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, 'reader')
    await authorize_personal_project(store, actor, space, request.personal_project_id)
    now = now_utc()
    window = store.settings.staffing_demand_window_days
    parameters = dict(space=request.personal_space_id, project=request.personal_project_id,
                      occupations=request.occupations)
    counts, _, _ = await store.runtime.driver.execute_query(
        '''
        UNWIND $occupations AS occupation
        OPTIONAL MATCH (:FuliSpace {id: $space, kind: 'personal'})-
          [:HAS_PROJECT_AGENT_TASK]->(task:FuliProjectAgentTask {personal_project_id: $project})-
          [:HAS_PARTICIPANT]->(agent:FuliProjectAgent)
        WHERE task.personal_space_id = $space
          AND task.created_at >= $since AND task.created_at <= $now
          AND task.status <> 'cancelled' AND agent.occupation_role = occupation
          AND agent.occupation_updated_at <= task.created_at
        RETURN occupation, count(DISTINCT task) AS task_count
        ''', **parameters, since=now - timedelta(days=window), now=now, routing_='r',
    )
    dedicated, _, _ = await store.runtime.driver.execute_query(
        '''
        UNWIND $occupations AS occupation
        OPTIONAL MATCH (space:FuliSpace {id: $space, kind: 'personal'})-[:CONTAINS_PROJECT]->
          (:FuliPersonalProject {project_id: $project})-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
          (:FuliProjectAgentAssignment {status: 'active'})-[:ASSIGNED_AGENT]->
          (agent:FuliProjectAgent {status: 'active', agent_type: 'durable'})
        WHERE agent.occupation_role = occupation AND NOT EXISTS {
          MATCH (space)-[:CONTAINS_PROJECT]->(other:FuliPersonalProject)-
            [:HAS_PROJECT_AGENT_ASSIGNMENT]->(:FuliProjectAgentAssignment {status: 'active'})-
            [:ASSIGNED_AGENT]->(agent)
          WHERE other.project_id <> $project
        }
        RETURN occupation, count(DISTINCT agent) > 0 AS has_dedicated
        ''', **parameters, routing_='r',
    )
    dedicated_roles = {row['occupation']: row['has_dedicated'] for row in dedicated}
    return {
        'window_days': window, 'task_threshold': store.settings.staffing_demand_task_threshold,
        'as_of': now.isoformat(),
        # Older work cannot be attributed to a new occupation without a historical snapshot.
        'basis': 'distinct non-cancelled tasks created since the current occupation was set',
        'occupations': [{'occupation': row['occupation'], 'task_count': row['task_count'],
                         'has_dedicated': dedicated_roles.get(row['occupation'], False)} for row in counts],
    }
