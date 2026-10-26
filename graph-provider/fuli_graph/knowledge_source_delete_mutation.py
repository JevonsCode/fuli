"""Source-specific changes inside the existing space-locked delete transaction."""
from .knowledge_basis_review import apply_meaning, hold_deleted_sources
from .knowledge_source_delete_copies import remove_source_copies
from .publication_source_copies import scrub_publication_drafts
from .knowledge_source_memory import scrub_source_memory
from .knowledge_source_tasks import scrub_source_tasks


async def remove_source_delete(scoped, actor, space, plan, deletion_id, created_at, knowledge):
    """The caller already recomputed and confirmed this plan in its transaction.

    The shared knowledge port handles version chains, attached records and basis
    revisions; source copies and drafts join that same transaction. Any failure
    propagates to its owner and rolls the complete deletion back.
    """
    await hold_source_bases(scoped, actor, space, plan, deletion_id, created_at)
    await knowledge.remove_items(scoped, space, plan)
    await scrub_source_memory(scoped, space, plan['memory'], deletion_id)
    await scrub_source_tasks(scoped, space, plan['inventory']['task_ids'], deletion_id)
    await remove_source_copies(scoped, space, plan['inventory'])
    return await scrub_publication_drafts(scoped, space, plan['drafts'], deletion_id, created_at)


async def hold_source_bases(scoped, actor, space, plan, deletion_id, created_at):
    """Only losing the entire evidence basis puts a retained item on hold."""
    selected = set(plan['selection']['selected_keys'])
    retained = plan['selection']['retained_sources']
    removed = {episode['uuid'] for episode in plan['inventory']['episodes']}
    for row in plan['lineages']:
        key = row['key']
        kind, item_id = key.split(':', 1)
        lost_basis = key in retained and not retained[key]
        if lost_basis:
            await hold_deleted_sources(scoped, actor, space, kind, item_id,
                removed.intersection(row['source_episode_ids']), deletion_id, created_at)
        if key in selected or lost_basis:
            await apply_meaning(scoped, actor, space, kind, item_id, meaning='changed',
                reason='A basis it rests on was permanently deleted by the person.', changed_by='user',
                created_at=created_at, change_id=deletion_id)
