"""Compose the two source-deletion layers and bind all affected copies to a digest.

The knowledge port supplies the existing item/version record operations. Its
adapter is wired with the shared delete transaction; the planner owns no writes.
"""
import json

from fastapi import HTTPException

from .knowledge_hard_delete_models import KnowledgeHardDeleteDrafts, KnowledgeHardDeleteEpisode
from .knowledge_hard_delete_publications import publications_for_sources
from .knowledge_source_delete_inventory import source_delete_inventory
from .knowledge_source_delete_lineages import source_delete_lineages
from .knowledge_source_delete_models import SourceDeleteCounts, SourceDeleteItem, SourceDeletePreview
from .knowledge_source_delete_selection import source_delete_selection
from .knowledge_source_delete_target import source_delete_target
from .knowledge_source_fence import source_turn_key
from .provider_values import native_datetime, now_utc, sha256_text
from .publication_source_copies import drafts_for_sources, publication_draft_counts


async def plan_source_delete(store, space, item_id, request, knowledge):
    target = await source_delete_target(store, space, item_id, request)
    inventory = await source_delete_inventory(store, space, target)
    episode_ids = sorted(episode['uuid'] for episode in inventory['episodes'])
    lineages = await source_delete_lineages(store, space, episode_ids)
    try:
        selection = source_delete_selection(lineages, episode_ids, include=request.include, exclude=request.exclude)
    except ValueError as invalid:
        raise HTTPException(status_code=422, detail={'code': 'source_selection_invalid', 'message': str(invalid)}) from invalid
    all_keys = sorted({key for row in lineages for key in row['version_keys']})
    items, locks = await knowledge.item_rows(store, space, all_keys)
    by_key = {f'{item.item_kind}:{item.item_id}': item for item in items}
    selected_items = [by_key[key] for key in selection['deleted_keys']]
    records = await knowledge.record_ids(store, space, selected_items)
    sources = [dict(episode_id=row['uuid'], session_id=row.get('fuli_session_id'),
        source_application=row.get('fuli_source_application'), source_turn_id=row.get('fuli_source_turn_id'))
        for row in inventory['episodes']]
    drafts = await drafts_for_sources(store, space, sources, source_range=target)
    shown_keys = set(selection['default_keys']) | set(selection['affected_keys'])
    shown_versions = {version for row in lineages if row['key'] in shown_keys for version in row['version_keys']}
    publications = await publications_for_sources(store, space, [by_key[key] for key in sorted(shown_versions)],
                                                  episode_ids, source_range=target)
    draft_counts = publication_draft_counts(drafts, now_utc())
    selected = set(selection['selected_keys'])
    reviewed = set(selection['review_keys'])
    source_set = set(episode_ids)
    layers = {}
    for row in lineages:
        key = row['key']
        touched = source_set.intersection(row['source_episode_ids'])
        retained = set(row['source_episode_ids']) - source_set
        reason = ('sole_source' if touched and not retained else 'multiple_sources' if touched else
                  'attached_relationship' if key in selection['default_keys'] else 'derived')
        versions = [by_key[version].model_copy(update={'role': 'item' if index == 0 else 'version'})
                    for index, version in enumerate(row['version_keys'])]
        layers[key] = SourceDeleteItem(key=key, selected=key in selected, reason=reason,
            basis_changed=key in reviewed, source_count=len(row['source_episode_ids']),
            retained_source_count=len(retained), versions=versions)
    counts = SourceDeleteCounts(items=sum(item.item_kind == 'entity' for item in selected_items),
        versions=sum(len(row['version_keys']) - 1 for row in lineages if row['key'] in selected),
        relationships=sum(item.item_kind == 'relationship' for item in selected_items),
        episodes=len(episode_ids), dependents=len(reviewed), source_turns=len(inventory['task_ids']),
        conversation_events=len(inventory['event_ids']), conversation_summaries=len(inventory['conversation_ids']),
        **{category: len(ids) for category, ids in records.items()})
    removed = [KnowledgeHardDeleteEpisode(episode_id=row['uuid'], source_kind=row.get('fuli_source_kind'),
        source_application=row.get('fuli_source_application'), session_id=row.get('fuli_session_id'),
        excerpt=(row.get('fuli_source_excerpt') or '')[:280] or None, created_at=native_datetime(row.get('created_at')))
        for row in inventory['episodes']]
    turn_keys = {source_turn_key(store, space, row.get('fuli_source_application'), row.get('fuli_session_id'),
                               row.get('fuli_source_turn_id')) for row in inventory['episodes']}
    turn_keys = sorted(key for key in turn_keys if key)
    digest = sha256_text(json.dumps({'space': space['id'], 'target': [request.item_kind, item_id],
        'source_turn_keys': turn_keys,
        'include': sorted(set(request.include)), 'exclude': sorted(set(request.exclude)),
        'selection': selection, 'locks': locks, 'episodes': episode_ids, 'records': records,
        'tasks': inventory['task_versions'], 'events': inventory['event_versions'],
        'conversations': inventory['conversation_versions'],
        'drafts': [[row['draft']['id'], row['draft']['status'], row['draft'].get('submission_id'),
                    row['draft'].get('payload_scrubbed_by')] for row in drafts],
        'publications': [row.model_dump() for row in publications], 'counts': counts.model_dump()},
        sort_keys=True, separators=(',', ':'), ensure_ascii=False))
    preview = SourceDeletePreview(preview_id=digest, item_kind=request.item_kind, item_id=item_id,
        title=item_id, source_application=target.source_application, fuli_session_id=target.session_id,
        include=sorted(set(request.include)), exclude=sorted(set(request.exclude)),
        default_items=[layers[key] for key in selection['default_keys']],
        affected_items=[layers[key] for key in selection['affected_keys']], removed_episodes=removed,
        counts=counts, publications=publications, drafts=KnowledgeHardDeleteDrafts(**draft_counts))
    return {'preview': preview, 'target': target, 'inventory': inventory, 'selection': selection,
            'deleted_source_turn_keys': turn_keys,
            'lineages': lineages, 'items': selected_items, 'records': records, 'drafts': drafts}
