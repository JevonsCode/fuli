"""On-demand, private-space occupation catalog HTTP routes."""

from .occupation_catalog import OccupationCreate, OccupationEntry, OccupationRevision, OccupationUpdate


def register_occupation_routes(application, store, Actor):
    @application.get('/v1/occupations', response_model=list[OccupationEntry])
    async def list_occupations(personal_space_id: str, actor: Actor):
        return await store.list_occupations(actor, personal_space_id)

    @application.post('/v1/occupations', response_model=OccupationEntry)
    async def create_occupation(request: OccupationCreate, actor: Actor):
        return await store.create_occupation(actor, request)

    @application.put('/v1/occupations/{key}', response_model=OccupationEntry)
    async def update_occupation(key: str, request: OccupationUpdate, actor: Actor):
        return await store.update_occupation(actor, key, request)

    @application.post('/v1/occupations/{key}/archive', response_model=OccupationEntry)
    async def archive_occupation(key: str, request: OccupationRevision, actor: Actor):
        return await store.archive_occupation(actor, key, request)

    @application.delete('/v1/occupations/{key}', response_model=OccupationEntry)
    async def delete_occupation(key: str, request: OccupationRevision, actor: Actor):
        return await store.update_occupation(actor, key, request, delete=True)
