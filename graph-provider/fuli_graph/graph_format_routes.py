"""HTTP routes for a person's graph migration (rec#17 D-09 part 2).

Preview reads only and needs the ordinary access token. Apply and rollback
change records, so they take the human-review channel as well: its token
lives only in the provider's environment file, which the local console and
`fuli migrate` read and no Agent tool does.
"""

from typing import Literal

from pydantic import Field

from .graph_format_confirm import (
    apply_graph_migration,
    preview_graph_migration,
    rollback_graph_migration,
    undoable_graph_migrations,
)
from .model_base import StrictModel

Entrypoint = Literal['cli', 'http']


class GraphMigrationApply(StrictModel):
    digest: str = Field(min_length=64, max_length=64)
    entrypoint: Entrypoint


class GraphMigrationRollback(StrictModel):
    migration_id: str = Field(min_length=1, max_length=128)
    entrypoint: Entrypoint


def register_graph_format_routes(application, runtime, settings, Actor, HumanReviewer):
    @application.post('/v1/data-format/preview')
    async def preview(_actor: Actor) -> dict:
        return {'plan': await preview_graph_migration(runtime.driver.read_only(), settings),
                'undoable': await undoable_graph_migrations(runtime.driver.read_only())}

    @application.post('/v1/data-format/apply')
    async def apply(request: GraphMigrationApply, _reviewer: HumanReviewer) -> dict:
        result = await apply_graph_migration(
            runtime.driver.maintenance(), settings, digest=request.digest,
            actor={'entrypoint': request.entrypoint},
        )
        await runtime.refresh_data_format()
        return {**result, 'data_format': runtime.data_format.health()}

    @application.post('/v1/data-format/rollback')
    async def rollback(request: GraphMigrationRollback, _reviewer: HumanReviewer) -> dict:
        result = await rollback_graph_migration(
            runtime.driver.maintenance(), settings, migration_id=request.migration_id,
            actor={'entrypoint': request.entrypoint},
        )
        await runtime.refresh_data_format()
        return {**result, 'data_format': runtime.data_format.health()}
