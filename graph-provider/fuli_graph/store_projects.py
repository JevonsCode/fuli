from fastapi import HTTPException

from .models import (
    PersonalProjectRecord,
    PersonalProjectUpsert,
    ProjectDeleteResult,
    ProjectReleaseRecord,
    ProjectRelationCreate,
    ProjectRelationDecision,
    ProjectRelationRecord,
)
from .project_management import (
    delete_project as delete_public_project,
    list_project_releases as read_project_releases,
)
from .provider_values import now_utc, stable_uuid


class StoreProjects:
    async def list_project_releases(
        self,
        actor: dict,
        project_id: str,
    ) -> list[ProjectReleaseRecord]:
        self._require_workspace()
        return await read_project_releases(self, actor, project_id)

    async def delete_project(
        self,
        actor: dict,
        project_id: str,
    ) -> ProjectDeleteResult:
        return await delete_public_project(self, actor, project_id)

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
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $personal_space_id, kind: 'personal'})
            MERGE (project:FuliPersonalProject {id: $id})
            ON CREATE SET project.project_id = $project_id,
                          project.publication_key = $publication_key,
                          project.created_at = $updated_at
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
        )
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
        return self._personal_project(records[0]['project'], personal_space_id)

    async def create_project_relation(
        self,
        actor: dict,
        source_project_id: str,
        request: ProjectRelationCreate,
    ) -> ProjectRelationRecord:
        self._require_workspace()
        if source_project_id == request.target_project_id:
            raise HTTPException(status_code=422, detail='a project cannot relate to itself')
        await self.authorize(actor, source_project_id, 'maintainer')
        target, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (target:FuliSpace {
              id: $target_project_id,
              kind: 'project',
              visibility: 'public'
            })
            RETURN target
            ''',
            target_project_id=request.target_project_id,
            routing_='r',
        )
        if not target:
            raise HTTPException(status_code=404, detail='target project not found')
        if request.relation_type == 'PART_OF':
            existing_parent, _, _ = await self.runtime.driver.execute_query(
                '''
                MATCH (:FuliSpace {id: $source_project_id})-
                      [relation:FULI_PROJECT_RELATION {relation_type: 'PART_OF'}]->
                      (:FuliSpace)
                WHERE relation.status IN ['pending', 'active']
                RETURN relation.id AS id
                ''',
                source_project_id=source_project_id,
                routing_='r',
            )
            if existing_parent:
                raise HTTPException(status_code=409, detail='project already has a parent relation')
        relation_id = stable_uuid(
            self.settings.provider_id,
            'project-relation',
            source_project_id,
            request.relation_type,
            request.target_project_id,
        )
        relation_status = 'pending' if request.relation_type == 'PART_OF' else 'active'
        created_at = now_utc()
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (source:FuliSpace {id: $source_project_id, kind: 'project'})
            MATCH (target:FuliSpace {id: $target_project_id, kind: 'project'})
            MERGE (source)-[relation:FULI_PROJECT_RELATION {id: $id}]->(target)
            ON CREATE SET relation.source_project_id = $source_project_id,
                          relation.target_project_id = $target_project_id,
                          relation.relation_type = $relation_type,
                          relation.status = $relation_status,
                          relation.note = $note,
                          relation.created_by = $created_by,
                          relation.created_at = $created_at
            RETURN relation
            ''',
            source_project_id=source_project_id,
            target_project_id=request.target_project_id,
            id=relation_id,
            relation_type=request.relation_type,
            relation_status=relation_status,
            note=request.note,
            created_by=actor['id'],
            created_at=created_at,
        )
        return self._project_relation(records[0]['relation'])

    async def list_project_relations(
        self,
        actor: dict,
        project_id: str,
    ) -> list[ProjectRelationRecord]:
        self._require_workspace()
        await self.authorize(actor, project_id, 'reader')
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (source:FuliSpace)-[relation:FULI_PROJECT_RELATION]->
                  (target:FuliSpace)
            WHERE source.id = $project_id OR target.id = $project_id
            RETURN relation ORDER BY relation.created_at DESC
            ''',
            project_id=project_id,
            routing_='r',
        )
        return [self._project_relation(record['relation']) for record in records]

    async def decide_project_relation(
        self,
        actor: dict,
        target_project_id: str,
        relation_id: str,
        decision: ProjectRelationDecision,
    ) -> ProjectRelationRecord:
        self._require_workspace()
        await self.authorize(actor, target_project_id, 'maintainer')
        decided_at = now_utc()
        relation_status = 'active' if decision.decision == 'confirm' else 'rejected'
        records, _, _ = await self.runtime.driver.execute_query(
            '''
            MATCH (:FuliSpace)-[relation:FULI_PROJECT_RELATION {
              id: $relation_id,
              target_project_id: $target_project_id,
              relation_type: 'PART_OF',
              status: 'pending'
            }]->(:FuliSpace)
            SET relation.status = $relation_status,
                relation.decision_note = $note,
                relation.decided_by = $decided_by,
                relation.decided_at = $decided_at
            RETURN relation
            ''',
            relation_id=relation_id,
            target_project_id=target_project_id,
            relation_status=relation_status,
            note=decision.note,
            decided_by=actor['id'],
            decided_at=decided_at,
        )
        if not records:
            raise HTTPException(status_code=409, detail='project relation is not pending')
        return self._project_relation(records[0]['relation'])
