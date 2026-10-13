"""Ephemeral task invalidations for the single-process personal Provider.

Durable task history stays in the graph; every connection starts with a resync.
"""

import asyncio
import json
from typing import Annotated

from fastapi import Query
from fastapi.responses import StreamingResponse


def register_task_notification_routes(application, store, Actor):
    subscribers = {}

    def notify(personal_space_id, task_id):
        for queue in subscribers.get(personal_space_id, ()):
            change = {'taskId': task_id}
            if queue.full():
                queue.get_nowait()
                change = {'taskId': None}  # A slow reader resyncs all visible tasks.
            queue.put_nowait(change)

    @application.get('/v1/project-agent-task-events')
    async def task_events(
        actor: Actor,
        personal_space_id: Annotated[str, Query(min_length=1, max_length=128)],
    ):
        store._require_personal()
        await store.authorize(actor, personal_space_id, 'reader')

        async def events():
            queue = asyncio.Queue(maxsize=1)
            subscribers.setdefault(personal_space_id, set()).add(queue)
            try:
                yield 'event: ready\ndata: {}\n\n'
                while True:
                    try:
                        change = await asyncio.wait_for(queue.get(), timeout=30)
                    except TimeoutError:
                        yield ': keepalive\n\n'
                        continue
                    await store.authorize(actor, personal_space_id, 'reader')
                    yield f'data: {json.dumps(change, separators=(",", ":"))}\n\n'
            finally:
                subscribers[personal_space_id].discard(queue)
                if not subscribers[personal_space_id]:
                    del subscribers[personal_space_id]

        return StreamingResponse(events(), media_type='text/event-stream',
            headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

    return notify
