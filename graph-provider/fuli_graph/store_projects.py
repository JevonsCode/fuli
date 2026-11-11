from fastapi import HTTPException

from .models import (
    PersonalProjectRecord,
    PersonalProjectUpsert,
)
from .provider_values import now_utc, stable_uuid
from .project_brief import legacy_project_brief


class StoreProjects:
    async def upsert_personal_project(
        self,
        actor: dict,
        request: PersonalProjectUpsert,
    ) -> PersonalProjectRecord:
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        node_id = stable_uuid(
            self.settings.provider_id,
            request.personal_space_id,
            'personal-project',
            request.project_id,
        )
        publication_key = stable_uuid(node_id, 'publication')
        updated_at = now_utc()
        has_brief = request.profile.has_brief
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})
            OPTIONAL MATCH (existing:FuliPersonalProject {id: $id})
            WITH space, existing
            WHERE $has_brief OR existing IS NOT NULL
            MERGE (project:FuliPersonalProject {id: $id})
            ON CREATE SET project.project_id = $project_id,
                          project.publication_key = $publication_key,
                          project.created_at = $updated_at
            WITH space, project
            WHERE NOT $create_only OR project.created_at = $updated_at
            SET project.profile_json = $profile_json,
                project.name = $name,
                project.updated_at = $updated_at
            MERGE (space)-[:CONTAINS_PROJECT]->(project)
            RETURN project
            ''',
            personal_space_id=request.personal_space_id,
            id=node_id,
            project_id=request.project_id,
            publication_key=publication_key,
            profile_json=request.profile.model_dump_json(),
            name=request.profile.name,
            updated_at=updated_at,
            create_only=request.create_only,
            has_brief=has_brief,
        )
        if not records:
            if not has_brief:
                raise HTTPException(status_code=422, detail='Project brief requires non-empty purpose, scope, or boundaries')
            raise HTTPException(status_code=409, detail='personal project already exists')
        return self._personal_project(records[0]['project'], request.personal_space_id)

    async def list_personal_projects(
        self,
        actor: dict,
        personal_space_id: str,
    ) -> list[PersonalProjectRecord]:
        self._require_personal()
        await self.authorize(actor, personal_space_id, 'reader')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:CONTAINS_PROJECT]->(project:FuliPersonalProject)
            RETURN project ORDER BY project.updated_at DESC
            ''',
            personal_space_id=personal_space_id,
            routing_='r',
        )
        return [
            self._personal_project(record['project'], personal_space_id)
            for record in records
        ]

    async def get_personal_project(
        self,
        actor: dict,
        personal_space_id: str,
        project_id: str,
    ) -> PersonalProjectRecord:
        self._require_personal()
        await self.authorize(actor, personal_space_id, 'reader')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})-
                  [:CONTAINS_PROJECT]->
                  (project:FuliPersonalProject {project_id: $project_id})
            RETURN project
            ''',
            personal_space_id=personal_space_id,
            project_id=project_id,
            routing_='r',
        )
        if not records:
            raise HTTPException(status_code=404, detail='personal project not found')
        return await legacy_project_brief(
            self, self._personal_project(records[0]['project'], personal_space_id)
        )
