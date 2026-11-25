"""Prove the records a personal capture may change while the host holds copies."""
from contextlib import ExitStack, asynccontextmanager, nullcontext

from fastapi import HTTPException

from .knowledge_versions import lock_knowledge
from .project_write_gate import gate_space_directory, hold_writes, project_targets
from .store_transactions import query_store_transaction


async def check_capture_records(store, space, *, entities=(), relationships=(), episodes=()):
    if not getattr(store, '_checking_capture_records', False):
        return
    for pattern, ids in (('(item:Entity)', entities), ('()-[item:RELATES_TO]->()', relationships),
                         ('(item:Episodic)', episodes)):
        if not ids:
            continue
        rows, _, _ = await store.runtime.driver.execute_query(
            'UNWIND $ids AS id MATCH ' + pattern + ' WHERE item.uuid=id AND '
            '(item.group_id IS NULL OR item.group_id<>$group OR item.fuli_replica_owner IS NOT NULL '
            'OR size(coalesce(item.fuli_replica_scopes, []))>0) RETURN count(item) AS blocked',
            ids=list(set(ids)), group=space['group_id'])
        if rows[0]['blocked']:
            raise HTTPException(409, detail={'code': 'replica_read_only'})


@asynccontextmanager
async def capture_transaction(store, space, project, episode, entity_ids, relationship_ids, episode_id, complex_write):
    directory = gate_space_directory(getattr(store, 'settings', None), space['id'])
    with ExitStack() as held:
        check_items = False
        if directory is not None:
            try:
                held.enter_context(hold_writes(directory, None))
            except HTTPException as exc:
                if complex_write or exc.detail != {'code': 'project_scope_unknown'}:
                    raise
                # Keep freezes and copy imports serialized with this graph
                # commit. Explicit input scopes and every changed existing
                # item are checked separately below.
                held.enter_context(hold_writes(directory, None, maintenance=True))
                projects = {project} if project else set()
                for item in [*episode.entities, *episode.relationships]:
                    projects.update(item.inherited_project_ids)
                held.enter_context(project_targets(space['id'], projects))
                check_items = True
        guard = getattr(store.runtime.driver, 'replica_guard', None)
        classification = guard.classifying_copies() if directory is not None and guard is not None else nullcontext()
        async with classification, query_store_transaction(store) as scoped:
            await lock_knowledge(scoped, space)
            if check_items:
                scoped._checking_capture_records = True
                await check_capture_records(scoped, space, entities=entity_ids, relationships=relationship_ids,
                                            episodes=[episode_id])
            yield scoped
