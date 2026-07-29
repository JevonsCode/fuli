from uuid import uuid4

from fastapi import HTTPException

from .models import (
    ProjectDeleteResult,
    ProjectReleaseRecord,
    SpaceCreate,
    SpaceRecord,
)
from .provider_values import graphiti_group_id, now_utc, stable_uuid


async def publish_project(store, actor: dict, request: SpaceCreate) -> SpaceRecord:
    existing = await _owned_publication(store, actor, request.publication_key)
    if existing:
        if request.release is None:
            return store._space(
                existing,
                owner_id=actor['id'],
                role='maintainer',
                can_manage=True,
            )
        return await _update_project(store, actor, existing, request)
    return await _create_project(store, actor, request)


async def list_project_releases(
    store,
    actor: dict,
    project_id: str,
) -> list[ProjectReleaseRecord]:
    await store.authorize(actor, project_id, 'reader')
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $project_id, kind: 'project'})-
              [:HAS_RELEASE]->(release:FuliProjectRelease)
        RETURN release ORDER BY release.published_at DESC
        ''',
        project_id=project_id,
        routing_='r',
    )
    return [store._project_release(record['release']) for record in records]


async def delete_project(store, actor: dict, project_id: str) -> ProjectDeleteResult:
    store._require_workspace()
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {
          id: $project_id,
          kind: 'project',
          visibility: 'public'
        })
        MATCH (owner:FuliPrincipal)-[:OWNS]->(space)
        WHERE owner.id = $principal_id OR $provider_admin = true
        RETURN space.name AS name, space.group_id AS group_id
        ''',
        project_id=project_id,
        principal_id=actor['id'],
        provider_admin=bool(actor.get('provider_admin')),
        routing_='r',
    )
    if not records:
        raise HTTPException(status_code=403, detail='project owner or provider administrator required')

    project = records[0]
    await store.runtime.driver.execute_query(
        '''
        MATCH (space:FuliSpace {id: $project_id, kind: 'project'})
        OPTIONAL MATCH (artifact)
        WHERE artifact <> space AND (
          artifact.group_id = $group_id OR
          (artifact.project_id = $project_id AND
           (artifact:FuliProjectRelease OR artifact:FuliProposal))
        )
        WITH space, collect(DISTINCT artifact) AS artifacts
        FOREACH (artifact IN artifacts | DETACH DELETE artifact)
        DETACH DELETE space
        ''',
        project_id=project_id,
        group_id=project['group_id'],
    )
    return ProjectDeleteResult(
        project_id=project_id,
        project_name=project['name'],
        deleted=True,
    )


async def _owned_publication(store, actor: dict, publication_key: str | None):
    if not publication_key:
        return None
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (p:FuliPrincipal {id: $principal_id})-[:OWNS]->
              (s:FuliSpace {
                kind: 'project',
                publication_key: $publication_key
              })
        RETURN s
        ''',
        principal_id=actor['id'],
        publication_key=publication_key,
        routing_='r',
    )
    return records[0]['s'] if records else None


async def _update_project(store, actor: dict, existing, request: SpaceCreate) -> SpaceRecord:
    project_id = existing['id']
    release = request.release
    duplicate, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $project_id})-[:HAS_RELEASE]->
              (release:FuliProjectRelease {version: $version})
        RETURN release.id AS id
        ''',
        project_id=project_id,
        version=release.version,
        routing_='r',
    )
    if duplicate:
        raise HTTPException(status_code=409, detail='project release version already exists')

    published_at = now_utc()
    release_id = stable_uuid(project_id, 'release', release.version)
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (owner:FuliPrincipal {id: $principal_id})-[:OWNS]->
              (space:FuliSpace {id: $project_id, kind: 'project'})
        SET space.name = $name,
            space.description = $description,
            space.profile_json = $profile_json,
            space.release_version = $version,
            space.release_id = $release_id,
            space.release_summary = $summary,
            space.release_publisher_id = $principal_id,
            space.release_publisher_name = $publisher_name,
            space.released_at = $published_at,
            space.updated_at = $published_at
        CREATE (release:FuliProjectRelease {
          id: $release_id,
          project_id: $project_id,
          version: $version,
          summary: $summary,
          publisher_id: $principal_id,
          publisher_name: $publisher_name,
          published_at: $published_at
        })
        CREATE (space)-[:HAS_RELEASE]->(release)
        RETURN space
        ''',
        principal_id=actor['id'],
        publisher_name=actor.get('name') or actor['id'],
        project_id=project_id,
        name=request.name,
        description=request.description,
        profile_json=request.profile.model_dump_json() if request.profile else None,
        release_id=release_id,
        version=release.version,
        summary=release.summary,
        published_at=published_at,
    )
    return store._space(
        records[0]['space'],
        owner_id=actor['id'],
        role='maintainer',
        can_manage=True,
    )


async def _create_project(store, actor: dict, request: SpaceCreate) -> SpaceRecord:
    space_id = str(uuid4())
    group_id = graphiti_group_id(store.settings.provider_id, request.kind, space_id)
    created_at = now_utc()
    release = request.release
    if release:
        query = '''
        MATCH (principal:FuliPrincipal {id: $principal_id})
        CREATE (space:FuliSpace {
          id: $id,
          name: $name,
          kind: 'project',
          group_id: $group_id,
          description: $description,
          visibility: 'public',
          publication_key: $publication_key,
          profile_json: $profile_json,
          release_version: $version,
          release_id: $release_id,
          release_summary: $summary,
          release_publisher_id: $principal_id,
          release_publisher_name: $publisher_name,
          released_at: $created_at,
          updated_at: $created_at,
          created_at: $created_at
        })
        CREATE (principal)-[:OWNS {created_at: $created_at}]->(space)
        CREATE (principal)-[:MEMBER_OF {role: 'maintainer', created_at: $created_at}]->(space)
        CREATE (releaseNode:FuliProjectRelease {
          id: $release_id,
          project_id: $id,
          version: $version,
          summary: $summary,
          publisher_id: $principal_id,
          publisher_name: $publisher_name,
          published_at: $created_at
        })
        CREATE (space)-[:HAS_RELEASE]->(releaseNode)
        RETURN space
        '''
    else:
        query = '''
        MATCH (principal:FuliPrincipal {id: $principal_id})
        CREATE (space:FuliSpace {
          id: $id,
          name: $name,
          kind: 'project',
          group_id: $group_id,
          description: $description,
          visibility: 'public',
          publication_key: $publication_key,
          profile_json: $profile_json,
          created_at: $created_at
        })
        CREATE (principal)-[:OWNS {created_at: $created_at}]->(space)
        CREATE (principal)-[:MEMBER_OF {role: 'maintainer', created_at: $created_at}]->(space)
        RETURN space
        '''
    parameters = {
        'principal_id': actor['id'],
        'publisher_name': actor.get('name') or actor['id'],
        'id': space_id,
        'name': request.name,
        'group_id': group_id,
        'description': request.description,
        'publication_key': request.publication_key,
        'profile_json': request.profile.model_dump_json() if request.profile else None,
        'created_at': created_at,
        'release_id': stable_uuid(space_id, 'release', release.version) if release else None,
        'version': release.version if release else None,
        'summary': release.summary if release else None,
    }
    records, _, _ = await store.runtime.driver.execute_query(query, **parameters)
    return store._space(
        records[0]['space'],
        owner_id=actor['id'],
        role='maintainer',
        can_manage=True,
    )
