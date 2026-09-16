"""Project-local Agent continuity and recruitment authorization."""

from fastapi import HTTPException

from .personal_project_access import authorize_personal_project
from .project_agent_coordination_models import (
    ProjectAgentCoordinationPolicyRecord,
    ProjectAgentCoordinationPolicyUpdate,
)
from .provider_values import native_datetime, now_utc, stable_uuid


class StoreProjectAgentCoordinationPolicy:
    """Persist project automation and a stable team without absorbing peer roles."""

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
            team_lead_agent_id=raw.get('team_lead_agent_id'),
            auto_grow_team=raw.get('auto_grow_team', True),
            team_member_agent_ids=raw.get('team_member_agent_ids') or [],
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
        current = await self.get_project_agent_coordination_policy(
            actor, request.personal_space_id, request.personal_project_id,
        )
        if ('expected_updated_at' in request.model_fields_set
                and request.expected_updated_at != current.updated_at):
            raise HTTPException(status_code=409, detail='coordination policy changed; reload before saving')
        lead = (request.team_lead_agent_id if 'team_lead_agent_id' in request.model_fields_set
                else current.team_lead_agent_id)
        members = (request.team_member_agent_ids if 'team_member_agent_ids' in request.model_fields_set
                   else current.team_member_agent_ids)
        auto_grow = current.auto_grow_team if request.auto_grow_team is None else request.auto_grow_team
        if members and not lead:
            raise HTTPException(status_code=422, detail='select a team lead before adding members')
        if lead in members:
            raise HTTPException(status_code=422, detail='the team lead cannot also be a team member')
        if 'team_lead_agent_id' in request.model_fields_set or 'team_member_agent_ids' in request.model_fields_set:
            for agent_id in ([lead] if lead else []) + members:
                agent = await self.get_project_agent(
                    actor, request.personal_space_id, request.personal_project_id, agent_id,
                )
                profile = agent.profile
                active_assignment = any(
                    assignment.status == 'active'
                    and assignment.personal_project_id == request.personal_project_id
                    for assignment in agent.assignments
                )
                if (profile.status != 'active' or not active_assignment
                        or profile.agent_type != 'durable'
                        or any(cap.startswith('fuli.employee:') for cap in profile.capabilities)):
                    raise HTTPException(status_code=422, detail='team roles require active durable project assignments; HR and project managers remain peers')
        updated_at = now_utc()
        written, _, _ = await self.runtime.driver.execute_query(
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
            SET policy._fuli_write_lock = true
            REMOVE policy._fuli_write_lock
            WITH project, policy
            WHERE ($expected_updated_at IS NULL AND policy.updated_at IS NULL)
               OR (policy.updated_at.epochSeconds = $expected_updated_at.epochSeconds
                   AND policy.updated_at.nanosecond = $expected_updated_at.nanosecond)
            SET policy.ask_before_recruitment = $ask_before_recruitment,
                policy.auto_reuse_previous_agent = $auto_reuse_previous_agent,
                policy.auto_grow_team = $auto_grow_team,
                policy.team_lead_agent_id = $team_lead_agent_id,
                policy.team_member_agent_ids = $team_member_agent_ids,
                policy.updated_at = $updated_at
            MERGE (project)-[:HAS_PROJECT_AGENT_COORDINATION_POLICY]->(policy)
            RETURN policy
            ''',
            policy_id=policy_id,
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            ask_before_recruitment=request.ask_before_recruitment,
            auto_reuse_previous_agent=request.auto_reuse_previous_agent,
            auto_grow_team=auto_grow,
            team_lead_agent_id=lead,
            team_member_agent_ids=members,
            expected_updated_at=current.updated_at,
            updated_at=updated_at,
        )
        if not written:
            raise HTTPException(status_code=409, detail='coordination policy changed; reload before saving')
        return ProjectAgentCoordinationPolicyRecord(
            personal_space_id=request.personal_space_id,
            personal_project_id=request.personal_project_id,
            ask_before_recruitment=request.ask_before_recruitment,
            auto_reuse_previous_agent=request.auto_reuse_previous_agent,
            auto_grow_team=auto_grow,
            team_lead_agent_id=lead,
            team_member_agent_ids=members,
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
