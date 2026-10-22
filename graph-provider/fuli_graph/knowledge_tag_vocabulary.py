"""The console's view of the tag vocabulary (rec#11 D-07 part 2).

Lists tags by namespace and status with their aliases, relations and linked
item counts, the provisional review queue, and one tag's links, children,
merged tags and history with what can be undone. It reads only; every change
goes through knowledge_tag_governance or the part-1 writes. Outside the
owner's all-project view a reader sees the personal vocabulary and its current
project's, and never a link count or a linked item, because a personal tag's
links may sit on other projects' knowledge (G2-5).
"""
from .knowledge_tag_governance import restore_remaining
from .knowledge_tag_governance_models import (
    KnowledgeTagDetail,
    KnowledgeTagDetailQuery,
    KnowledgeTagEntry,
    KnowledgeTagHistoryEntry,
    KnowledgeTagLinkedItem,
    KnowledgeTagUnfinishedRestore,
    KnowledgeTagVocabulary,
    KnowledgeTagVocabularyQuery,
)
from .knowledge_tag_models import LIVE_STATUSES
from .knowledge_tags import reference, visible_tag, visible_tag_scope
from .name_identity import identity_key

MAX_DETAIL_LINKS = 200
MAX_HISTORY = 100
_UNDOABLE_ACTIONS = frozenset({'approve', 'merge', 'split', 'retire', 'remove_alias', 'relate', 'unrelate',
                               'revive'})


async def list_vocabulary(store, actor: dict, request: KnowledgeTagVocabularyQuery) -> KnowledgeTagVocabulary:
    space, namespaces = await visible_tag_scope(store, actor, request, 'reader',
                                                all_projects=request.include_all_projects)
    reader = store.knowledge_tag_vocabulary().reader(space['id'])
    tags = {tag['id']: tag for tag in await reader.all_tags()}
    visible = [tag for tag in tags.values() if namespaces is None or tag['namespace_key'] in namespaces]
    review_count = sum(1 for tag in visible if _needs_review(tag))
    query = identity_key(request.query) if request.query else None
    chosen = sorted((tag for tag in visible if _matches(tag, request, query)),
                    key=lambda tag: (tag['namespace_key'] != 'personal', tag['namespace_key'], tag['name_key']))
    page = chosen[request.offset:request.offset + request.limit]
    counts = await reader.link_counts([tag['id'] for tag in page]) if namespaces is None else None
    end = request.offset + len(page)
    return KnowledgeTagVocabulary(
        tags=[_entry(tag, tags, namespaces, counts) for tag in page], total=len(chosen),
        next_offset=end if end < len(chosen) else None, review_count=review_count)


async def read_tag_detail(store, actor: dict, request: KnowledgeTagDetailQuery) -> KnowledgeTagDetail:
    space, namespaces = await visible_tag_scope(store, actor, request, 'reader',
                                                all_projects=request.include_all_projects)
    vocabulary = store.knowledge_tag_vocabulary()
    reader = vocabulary.reader(space['id'])
    tag = await visible_tag(reader, namespaces, request.tag_id)
    tags = {entry['id']: entry for entry in await reader.all_tags()}
    shown = [entry for entry in tags.values() if namespaces is None or entry['namespace_key'] in namespaces]
    links, truncated = None, False
    if namespaces is None:
        attached = await reader.links_of([tag['id']], limit=MAX_DETAIL_LINKS + 1)
        truncated = len(attached) > MAX_DETAIL_LINKS
        attached = attached[:MAX_DETAIL_LINKS]
        titles = await vocabulary.item_titles(space, attached)
        links = [KnowledgeTagLinkedItem(
            item_kind=link['item_kind'], item_id=link['item_id'],
            title=titles.get((link['item_kind'], link['item_id'])), attached_at=link.get('attached_at'),
            moved_from=reference(tags[link['moved_from_tag_id']])
            if link.get('moved_from_tag_id') in tags else None) for link in attached]
    return KnowledgeTagDetail(
        tag=_entry(tag, tags, namespaces, await reader.link_counts([tag['id']]) if namespaces is None else None),
        children=[reference(entry) for entry in _by_name(shown) if entry['status'] in LIVE_STATUSES
                  and tag['id'] in (entry.get('parent_ids') or [])],
        merged_from=[reference(entry) for entry in _by_name(shown) if entry['status'] == 'merged'
                     and entry.get('merged_into_id') == tag['id']],
        unfinished_restores=await _unfinished_restores(reader, tag, tags, namespaces),
        links=links, links_truncated=truncated,
        history=await _history(reader, tag, tags, namespaces))


async def _unfinished_restores(reader, tag: dict, tags: dict, namespaces) -> list[KnowledgeTagUnfinishedRestore]:
    """Tags a split already brought back from a merge into this one while items
    that merge took are still here: the next batch continues from the merge record.
    Only the owner's all-project view gets them: the remaining count reads links
    across every project, so a scoped read never sees it (G2-5, dot on 90e8baf)."""
    if namespaces is not None:
        return []
    unfinished = []
    for merge in await reader.merges_into(tag['id']):
        merged = tags.get(merge['tag_id'])
        if merged is None or merged['status'] not in LIVE_STATUSES:
            continue
        remaining = await restore_remaining(reader, tag['id'], merged['id'])
        if remaining:
            unfinished.append(KnowledgeTagUnfinishedRestore(tag=reference(merged), remaining=len(remaining)))
    return unfinished


async def _history(reader, tag: dict, tags: dict, namespaces) -> list[KnowledgeTagHistoryEntry]:
    revisions = await reader.revisions(tag['id'], MAX_HISTORY)
    operation_ids = [revision['operation_id'] for revision in revisions if revision.get('operation_id')]
    operations = await reader.operations(operation_ids)
    undone = await reader.undone(list(operations))

    def other(revision):
        related = tags.get(revision.get('related_tag_id'))
        visible = related is not None and (namespaces is None or related['namespace_key'] in namespaces)
        return reference(related) if visible else None

    return [KnowledgeTagHistoryEntry(
        action=revision['action'], actor_kind=revision['actor_kind'], reason=revision.get('reason'),
        created_at=revision['created_at'], version=int(revision.get('version') or 0),
        operation_id=revision.get('operation_id'), alias=revision.get('alias'),
        relation=revision.get('relation'), other=other(revision),
        undone=revision.get('operation_id') in undone,
        undoable=revision.get('operation_id') in operations and revision.get('operation_id') not in undone
        and operations[revision['operation_id']]['action'] in _UNDOABLE_ACTIONS) for revision in revisions]


def _entry(tag: dict, tags: dict, namespaces, counts) -> KnowledgeTagEntry:
    def shown(tag_id):
        related = tags.get(tag_id)
        return related is not None and related['status'] in LIVE_STATUSES and (
            namespaces is None or related['namespace_key'] in namespaces)

    target = _merge_target(tag, tags)
    return KnowledgeTagEntry(
        id=tag['id'], name=tag['name'], namespace=tag['namespace_kind'], project_id=tag.get('namespace_project_id'),
        status=tag['status'], description=tag.get('description'), aliases=list(tag['aliases']),
        provisional_aliases=[alias for alias, status in zip(tag['aliases'], tag['alias_statuses'])
                             if status == 'provisional'],
        proposed_aliases=list(tag['proposed_aliases']),
        linked_items=None if counts is None else counts.get(tag['id'], 0),
        parents=[reference(tags[tag_id]) for tag_id in tag.get('parent_ids') or [] if shown(tag_id)],
        related=[reference(tags[tag_id]) for tag_id in tag.get('related_ids') or [] if shown(tag_id)],
        merged_into=reference(target) if target else None, needs_review=_needs_review(tag),
        source={'kind': tag['source_kind'], 'application': tag.get('source_application'),
                'reason': tag['source_reason']},
        version=int(tag['version']), created_at=tag['created_at'], updated_at=tag['updated_at'])


def _merge_target(tag: dict, tags: dict) -> dict | None:
    """Where a merged tag leads now, read from the loaded vocabulary."""
    seen = set()
    while tag is not None and tag['status'] == 'merged' and tag['id'] not in seen:
        seen.add(tag['id'])
        tag = tags.get(tag.get('merged_into_id'))
    return tag if seen and tag is not None and tag['status'] in LIVE_STATUSES else None


def _needs_review(tag: dict) -> bool:
    """Waiting for the person: a provisional tag, or an alias an Agent added or proposed."""
    return tag['status'] in LIVE_STATUSES and (
        tag['status'] == 'provisional' or bool(tag['proposed_aliases'])
        or 'provisional' in tag['alias_statuses'])


def _matches(tag: dict, request: KnowledgeTagVocabularyQuery, query: str | None) -> bool:
    if request.namespace and tag['namespace_kind'] != request.namespace:
        return False
    if request.status == 'review' and not _needs_review(tag):
        return False
    if request.status not in (None, 'review') and tag['status'] != request.status:
        return False
    return query is None or query in tag['name_key'] or any(query in alias for alias in tag['alias_keys']) \
        or query in identity_key(tag.get('description') or '')


def _by_name(tags):
    return sorted(tags, key=lambda tag: tag['name_key'])
