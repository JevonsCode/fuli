"""Resolve a human source target from its stored identity before any planning."""
from dataclasses import dataclass

from fastapi import HTTPException

from .knowledge_source_fence import require_source_available


@dataclass(frozen=True)
class SourceDeleteTarget:
    item_kind: str
    item_id: str
    source_application: str | None
    session_id: str | None
    turn_id: str | None = None

    @property
    def whole_session(self):
        return self.item_kind == 'session'

    @property
    def exact_turn(self):
        return bool(self.source_application and self.session_id and self.turn_id)


async def source_delete_target(store, space, item_id, request):
    if request.item_kind == 'session':
        if item_id != store._task_session_id(space['id'], request.source_application, request.fuli_session_id):
            raise HTTPException(status_code=409, detail={'code': 'source_identity_mismatch'})
        await require_source_available(store, space, source_application=request.source_application,
                                       session_id=request.fuli_session_id)
        return SourceDeleteTarget('session', item_id, request.source_application, request.fuli_session_id)
    await require_source_available(store, space, episode_id=item_id)
    rows, _, _ = await store.runtime.driver.execute_query(
        '''MATCH (episode:Episodic {group_id: $group_id, uuid: $episode_id})
           RETURN episode.fuli_source_application AS source_application,
                  episode.fuli_session_id AS session_id, episode.fuli_source_turn_id AS turn_id''',
        group_id=space['group_id'], episode_id=item_id, routing_='r')
    if not rows:
        raise HTTPException(status_code=404, detail={'code': 'source_not_found'})
    row = rows[0]
    await require_source_available(store, space, episode_id=item_id,
        source_application=row['source_application'], session_id=row['session_id'], source_turn_id=row['turn_id'])
    return SourceDeleteTarget('episode', item_id, row['source_application'], row['session_id'], row['turn_id'])
