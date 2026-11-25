"""Local Provider ports used only by the project move participant."""
import json

from fastapi import Request
from pydantic import Field

from .handover_permission import authorized_phase
from .models import StrictModel
from .scope_handover import convert, discard_staged, inspect_project, refuse, stage
from .scope_export import read_space


class HandoverScope(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1, max_length=128)
    move_id: str = Field(min_length=1, max_length=128)
    phase: str


def register_handover_routes(application, store, Actor):
    @application.post('/v1/scopes/handover')
    async def handover(request: Request, actor: Actor, personal_space_id: str, project_id: str, move_id: str, phase: str):
        from .scope_export import canonical
        store._require_personal()
        target = HandoverScope(personal_space_id=personal_space_id, project_id=project_id, move_id=move_id, phase=phase)
        space = await store.authorize(actor, target.personal_space_id, 'maintainer')
        if space['kind'] != 'personal' or phase not in ('seal','baseline','stage','restore','discard','promote','demote'):
            refuse('project_move_phase_unknown')
        bundle = None
        if phase in ('stage','restore'):
            buf = bytearray()
            async for block in request.stream():
                if len(buf) + len(block) > 64 * 1024 * 1024:
                    refuse('project_move_package_too_large')
                buf.extend(block)
            try:
                bundle = json.loads(buf)
            except ValueError:
                refuse('project_move_package_invalid')
        with authorized_phase(store.settings, space['id'], project_id, move_id, phase) as control:
            if phase in ('seal','baseline'):
                async with store.runtime.driver.read_transaction() as tx:
                    if phase == 'baseline' and project_id not in (await read_space(tx, space)).classification.project_ids:
                        return {'ok': True, 'empty': True}
                    data, _, _, owner = await inspect_project(tx, space, project_id, store.settings.provider_id)
                    expected = None if phase == 'seal' else control['source']
                    if owner != expected:
                        refuse('project_move_wrong_owner')
                    if len(canonical(data).encode()) > 64 * 1024 * 1024:
                        refuse('project_move_package_too_large')
                    return data
            if phase in ('stage','restore'):
                return await stage(store, actor, space, project_id, phase, control, bundle)
            if phase == 'discard':
                return await discard_staged(store, space, project_id, control)
            return await convert(store, space, project_id, move_id, phase, control)
