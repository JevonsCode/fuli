from fastapi import HTTPException
from pydantic import Field

from .models import StrictModel


class CopySourceItems(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    entities: list[str] = Field(max_length=200)
    facts: list[str] = Field(max_length=200)


def register_copy_source_route(app, store, Actor):
    @app.post('/v1/scopes/item-sources')
    async def sources(request: CopySourceItems, actor: Actor):
        store._require_personal()
        space = await store.authorize(actor, request.personal_space_id, 'maintainer')
        if space['kind'] != 'personal':
            raise HTTPException(422, detail='project sources require a personal space')
        rows, _, _ = await store.runtime.driver.execute_query(
            """
            MATCH (n:Entity {group_id:$group}) WHERE n.uuid IN $entities AND n.fuli_replica_owner IS NOT NULL
            RETURN 'entities' AS kind, n.uuid AS id, n.fuli_replica_owner AS owner, n.fuli_replica_scopes AS scopes
            UNION ALL
            MATCH ()-[r:RELATES_TO {group_id:$group}]->() WHERE r.uuid IN $facts AND r.fuli_replica_owner IS NOT NULL
            RETURN 'facts' AS kind, r.uuid AS id, r.fuli_replica_owner AS owner, r.fuli_replica_scopes AS scopes
            """, group=space['group_id'], entities=request.entities, facts=request.facts, routing_='r')
        return [dict(row) for row in rows]
