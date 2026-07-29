from fastapi import HTTPException


async def authorize_personal_project(
    store,
    actor: dict,
    space: dict,
    project_id: str,
) -> dict:
    if store.settings.provider_mode != 'personal' or space['kind'] != 'personal':
        raise HTTPException(
            status_code=422,
            detail='personal project scope requires a personal space',
        )
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliPrincipal {id: $principal_id})-[:OWNS]->
              (:FuliSpace {id: $space_id, kind: 'personal'})-[:CONTAINS_PROJECT]->
              (project:FuliPersonalProject {project_id: $project_id})
        RETURN project
        ''',
        principal_id=actor['id'],
        space_id=space['id'],
        project_id=project_id,
        routing_='r',
    )
    if not records:
        raise HTTPException(status_code=404, detail='personal project not found')
    return dict(records[0]['project'])
