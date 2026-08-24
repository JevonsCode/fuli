"""Project-local Agent continuity and recruitment authorization."""

from .personal_project_access import authorize_personal_project
from .project_agent_coordination_models import (
    ProjectAgentCoordinationPolicyRecord,
    ProjectAgentCoordinationPolicyUpdate,
)
from .provider_values import native_datetime, now_utc, stable_uuid


class StoreProjectAgentCoordinationPolicy:
    """Persist the two user-facing project Agent automation switches."""

    async def get_project_agent_coordination_policy(
        self,
        actor: dict,
        personal_space_id: str,
        personal_project_id: str,
    ) -> ProjectAgentCoordinationPolicyRecord:
        self._require_personal()
        space = await self.authorize(actor, personal_space_id, 'reader')
        await authorize_personal_project(
            self,
            actor,
            space,
            personal_project_id,
        )
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:CONTAINS_PROJECT]->
                  (project:FuliPersonalProject {project_id: $personal_project_id})
            OPTIONAL MATCH (project)-[:HAS_PROJECT_AGENT_COORDINATION_POLICY]->
                  (policy:FuliProjectAgentCoordinationPolicy {
                    policy_id: $policy_id
                  })
            RETURN policy
            ''',
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            policy_id=self._project_agent_coordination_policy_id(
                personal_space_id,
                personal_project_id,
            ),
            routing_='r',
        )
        raw = dict(records[0]['policy']) if records and records[0].get('policy') else {}
        return ProjectAgentCoordinationPolicyRecord(
            personal_space_id=personal_space_id,
            personal_project_id=personal_project_id,
            ask_before_recruitment=raw.get('ask_before_recruitment', True),
            auto_reuse_previous_agent=raw.get(
                'auto_reuse_previous_agent',
                True,
            ),
            updated_at=native_datetime(raw.get('updated_at')),
        )

    async def update_project_agent_coordination_policy(
        self,
        actor: dict,
        request: ProjectAgentCoordinationPolicyUpdate,
    ) -> ProjectAgentCoordinationPolicyRecord:
        self._require_personal()
        space = await self.authorize(
            actor,
            request.personal_space_id,
            'maintainer',
        )
        await authorize_personal_project(
            self,
            actor,
            space,
            request.personal_project_id,
        )
        policy_id = self._project_agent_coordination_policy_id(
            request.personal_space_id,
            request.personal_project_id,
        )
        updated_at = now_utc()
        await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:CONTAINS_PROJECT]->
                  (project:FuliPersonalProject {project_id: $personal_project_id})
            MERGE (policy:FuliProjectAgentCoordinationPolicy {
              policy_id: $policy_id
            })
            ON CREATE SET policy.personal_space_id = $personal_space_id,
                          policy.personal_project_id = $personal_project_id,
                          policy.created_at = $updated_at
            SET policy.ask_before_recruitment = $ask_before_recruitment,
                policy.auto_reuse_previous_agent = $auto_reuse_previous_agent,
                policy.updated_at = $updated_at
            MERGE (project)-[:HAS_PROJECT_AGENT_COORDINATION_POLICY]->(policy)
            ''',
            policy_id=policy_id,
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            ask_before_recruitment=request.ask_before_recruitment,
            auto_reuse_previous_agent=request.auto_reuse_previous_agent,
            updated_at=updated_at,
        )
        return ProjectAgentCoordinationPolicyRecord(
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            ask_before_recruitment=request.ask_before_recruitment,
            auto_reuse_previous_agent=request.auto_reuse_previous_agent,
            updated_at=updated_at,
        )

    def _project_agent_coordination_policy_id(
        self,
        personal_space_id: str,
        personal_project_id: str,
    ) -> str:
        return stable_uuid(
            self.settings.provider_id,
            personal_space_id,
            'project-agent-coordination-policy',
            personal_project_id,
        )
