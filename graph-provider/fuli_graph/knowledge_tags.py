"""Reuse a tag before creating one (rec#5 section 3, Graphify G4).

Tags only help find knowledge. Nothing here reads or changes an item's content,
confirmation, authority or evidence, and a tag never widens what a caller may
see: the visible vocabulary is the personal one plus the current project's.
Similar tags are returned as candidates and never merged; a synonym becomes the
same tag only through an explicit alias, and two tags become one only through
the person's merge (knowledge_tag_governance). A merged tag's ID and words lead
to the tag it went into (knowledge_tag_redirects). Every create, alias, attach
and detach is decided and written under the space's knowledge lock, so
concurrent near-duplicates, and a merge racing an attach, are judged one after
the other (G4-4, G4-5). A write claimed as the person's own needs the
human-review proof the local console sends (rec#11 D-22).
"""
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from .knowledge_tag_models import (
    DISTINCT_FROM_MAX,
    KnowledgeTagAliasCreate,
    KnowledgeTagAliasResult,
    KnowledgeTagCreate,
    KnowledgeTagCreateResult,
    KnowledgeTagLinkChange,
    KnowledgeTagLinkResult,
    KnowledgeTagMetrics,
    KnowledgeTagMetricsQuery,
    KnowledgeTagRecord,
    KnowledgeTagReference,
    KnowledgeTagResolve,
    KnowledgeTagResolveResult,
    KnowledgeTagScope,
)
from .knowledge_tag_redirects import live_target
from .knowledge_tag_similarity import (
    decision_candidate,
    find_candidates,
    similarity_version,
    tag_candidate,
    word_holders,
)
from .name_identity import identity_key
from .personal_project_access import authorize_personal_project
from .provider_values import now_utc, stable_uuid

PERSONAL_NAMESPACE = 'personal'
MAX_TAGS_PER_ITEM = 32
# A decision shows a few candidates at a time, never the whole vocabulary.
MAX_DECISION_CANDIDATES = 5
_NEEDS_DECISION = ('Reuse a candidate (attach it; add_alias for a synonym) or create again with '
                   'distinctFrom listing every candidate id. A project candidate exists only there.')
_TOO_MANY = (f'More similar tags than distinctFrom can list ({DISTINCT_FROM_MAX}): '
             'reuse one or choose a more specific name.')
_ALIAS_HELD = 'Another visible tag already holds this word: attach that tag instead.'
_ALIAS_PROPOSED = 'Saved as a proposal; resolve ignores it until a person adds the same alias.'
_SHARED_REFUSED = 'shared vocabulary changes need governance and are not available yet'
_NO_CURRENT_PROJECT = 'with no current project, set namespace personal explicitly'
_HUMAN_PROOF = 'independent human review proof required'
_RETIRED = 'A person retired this tag; only they can bring it back, from the FULI console.'
_REVIVED = ('Brought back; {} relations and {} aliases that no longer fit were dropped; '
            'undoing the revival in the console restores them.')


def project_namespace(project_id: str) -> str:
    return f'project:{project_id}'


def _require_human_proof(actor: dict, operation_actor: str) -> None:
    """A change recorded as the person's own needs the console's human-review proof."""
    if operation_actor == 'human' and actor.get('_human_review_verified') is not True:
        raise HTTPException(status_code=403, detail=_HUMAN_PROOF)


async def resolve_tags(store, actor: dict, request: KnowledgeTagResolve) -> KnowledgeTagResolveResult:
    space, namespaces = await visible_tag_scope(store, actor, request, 'reader')
    candidates = await find_candidates(
        store, store.knowledge_tag_vocabulary().reader(space['id']), identity_key(request.query),
        key_namespaces=namespaces, scan_namespaces=namespaces)
    return KnowledgeTagResolveResult(query=request.query, candidates=candidates.found[:request.limit],
                                     truncated=candidates.truncated,
                                     similarity_version=similarity_version(store))


async def create_tag(store, actor: dict, request: KnowledgeTagCreate) -> KnowledgeTagCreateResult:
    _require_human_proof(actor, request.operation_actor)
    namespace = _new_tag_namespace(request)
    space, visible = await visible_tag_scope(store, actor, request, 'maintainer')
    key = identity_key(request.name)
    acknowledged = set(request.distinct_from)
    version = similarity_version(store)
    # A personal tag is judged against the personal vocabulary only; a same-name
    # tag of the current project still shows, as a scope difference to decide.
    scanned = visible if namespace == 'project' else [PERSONAL_NAMESPACE]
    async with store.knowledge_tag_vocabulary().locked(space['id']) as vocabulary:
        candidates = await find_candidates(store, vocabulary, key, key_namespaces=visible,
                                           scan_namespaces=scanned)
        decided = {'normalized': key, 'truncated': candidates.truncated,
                   'similarity_version': version}
        reused = _reused(candidates.found, namespace, acknowledged)
        if reused:
            others = [decision_candidate(candidate) for candidate in candidates.found
                      if candidate.id != reused.id]
            return KnowledgeTagCreateResult(
                outcome='existing', tag=tag_record(await vocabulary.get_any(reused.id)),
                candidates=others[:MAX_DECISION_CANDIDATES], **decided)
        undecided = [candidate for candidate in candidates.found if candidate.id not in acknowledged]
        if undecided:
            return KnowledgeTagCreateResult(
                outcome='needs_decision', tag=None, undecided=len(undecided),
                candidates=[decision_candidate(candidate)
                            for candidate in undecided[:MAX_DECISION_CANDIDATES]],
                guidance=_TOO_MANY if len(candidates.found) > DISTINCT_FROM_MAX else _NEEDS_DECISION,
                **decided)
        tag = _new_tag(actor, space['id'], request, namespace, key,
                       {candidate.id for candidate in candidates.found})
        earlier = await vocabulary.by_identity(tag['namespace_key'], key)
        if earlier is not None:
            stored, settled = await _reuse_earlier_identity(vocabulary, space, actor, earlier, request)
        else:
            stored, settled = (await vocabulary.apply(new_tags=[tag], revisions=[_revision(
                tag, 'create', request, tag['created_at'], similarity_version=version)]))[tag['id']], {}
    dropped = len(settled.get('dropped', [])), len(settled.get('aliases_dropped', []))
    return KnowledgeTagCreateResult(outcome='created', tag=tag_record(stored), candidates=[], **decided,
                                    guidance=_REVIVED.format(*dropped) if any(dropped) else None)


async def _reuse_earlier_identity(vocabulary, space: dict, actor: dict, earlier: dict,
                                  request: KnowledgeTagCreate) -> tuple[dict, dict]:
    """The word's identity in this namespace already exists but does not resolve:
    merged (its word leads elsewhere, so a reader would have found that tag
    unless the caller judged it different) or retired. Only the person brings
    a retired tag back; a merged word stays with its merge until the person splits it."""
    if earlier['status'] == 'merged':
        target = await live_target(vocabulary, earlier)
        raise HTTPException(status_code=409, detail={
            'code': 'tag_merged', 'message': 'A person merged this word into another tag; reuse that '
            'tag, or ask the person to split it in the FULI console.',
            'tag': reference(target).model_dump() if target else None})
    if request.operation_actor != 'human':
        raise HTTPException(status_code=409, detail={'code': 'tag_retired', 'message': _RETIRED,
                                                      'tag': reference(earlier).model_dump()})
    # Imported here: governance builds on this module's records and checks.
    from .knowledge_tag_governance import revive_on_create
    return await revive_on_create(vocabulary, space, actor['id'], earlier, request.reason)


async def add_tag_alias(store, actor: dict, request: KnowledgeTagAliasCreate) -> KnowledgeTagAliasResult:
    _require_human_proof(actor, request.operation_actor)
    space, namespaces = await visible_tag_scope(store, actor, request, 'maintainer')
    key = identity_key(request.alias)
    async with store.knowledge_tag_vocabulary().locked(space['id']) as vocabulary:
        _, tag = await _live_visible_tag(vocabulary, namespaces, request.tag_id)
        at = now_utc()
        if key == tag['name_key'] or key in tag['alias_keys']:
            if not _confirms_provisional(tag, key, request.operation_actor):
                return KnowledgeTagAliasResult(outcome='unchanged', tag=tag_record(tag), normalized=key)
            # A person adding an Agent's provisional alias accepts it: same entry, now active.
            stored = await _save_aliases(vocabulary, tag, _with_alias_status(tag, key, 'active'), _revision(
                tag, 'confirm_alias', request, at, alias=request.alias, alias_status='active'), at)
            return KnowledgeTagAliasResult(outcome='added', tag=tag_record(stored), normalized=key)
        holders = [other for other in await word_holders(vocabulary, namespaces, key) if other['id'] != tag['id']]
        if holders:
            # A merge in disguise: an alias never makes two visible tags share a word.
            return KnowledgeTagAliasResult(
                outcome='conflict', tag=tag_record(tag), normalized=key, guidance=_ALIAS_HELD,
                candidates=[decision_candidate(_held(other, key)) for other in holders])
        if request.operation_actor == 'human' or _agent_alias_takes_effect(tag):
            status = 'active' if request.operation_actor == 'human' else 'provisional'
            outcome, fields = 'added', _with_alias(tag, request.alias, key, status)
        elif key in tag['proposed_alias_keys']:
            return KnowledgeTagAliasResult(outcome='unchanged', tag=tag_record(tag), normalized=key,
                                           guidance=_ALIAS_PROPOSED)
        else:
            status, outcome = 'proposed', 'proposed'
            fields = {'proposed_aliases': [*tag['proposed_aliases'], request.alias],
                      'proposed_alias_keys': [*tag['proposed_alias_keys'], key]}
        stored = await _save_aliases(vocabulary, tag, fields, _revision(
            tag, 'add_alias' if outcome == 'added' else 'propose_alias', request, at,
            alias=request.alias, alias_status=status), at)
    return KnowledgeTagAliasResult(outcome=outcome, tag=tag_record(stored), normalized=key,
                                   guidance=_ALIAS_PROPOSED if outcome == 'proposed' else None)


async def _save_aliases(vocabulary, tag: dict, fields: dict, revision: dict, at) -> dict:
    return (await vocabulary.apply(updates=[{'id': tag['id'], 'at': at, 'fields': fields}],
                                   revisions=[revision]))[tag['id']]


async def attach_tag(store, actor: dict, request: KnowledgeTagLinkChange) -> KnowledgeTagLinkResult:
    return await _change_link(store, actor, request, attach=True)


async def detach_tag(store, actor: dict, request: KnowledgeTagLinkChange) -> KnowledgeTagLinkResult:
    return await _change_link(store, actor, request, attach=False)


async def _change_link(store, actor: dict, request: KnowledgeTagLinkChange, *, attach: bool):
    """Under the lock the item and the tag are read again: an attach that loses a
    race to a hard delete finds no item (no orphan link), and one that loses a
    race to a merge lands on the merged-into tag, never on a tag that no longer
    resolves. A hard delete and a merge take the same space lock."""
    _require_human_proof(actor, request.operation_actor)
    space, namespaces = await visible_tag_scope(store, actor, request, 'maintainer')
    port = store.knowledge_tag_vocabulary()
    await visible_tag(port.reader(space['id']), namespaces, request.tag_id)
    async with port.locked(space['id']) as vocabulary:
        await _require_taggable(port, space, request)
        named, tag = await _live_visible_tag(vocabulary, namespaces, request.tag_id)
        link_id = tag_link_id(space['id'], tag['id'], request.item_kind, request.item_id)
        current = (await vocabulary.links_by_ids([link_id])).get(link_id)
        attached = current is not None and current['status'] == 'attached'
        at = now_utc()
        if attach and not attached:
            if await vocabulary.attached_count(request.item_kind, request.item_id) >= MAX_TAGS_PER_ITEM:
                raise HTTPException(status_code=409,
                                    detail=f'a knowledge item carries at most {MAX_TAGS_PER_ITEM} tags')
            await vocabulary.apply(links=[new_link(space['id'], tag['id'], request.item_kind, request.item_id,
                                                   at, request.operation_actor)])
            outcome = 'attached'
        elif not attach and attached:
            await vocabulary.apply(links=[{**current, 'status': 'detached', 'detached_at': at,
                                           'detached_by_kind': request.operation_actor}])
            outcome = 'detached'
        else:
            outcome = 'unchanged'
        tags = await vocabulary.item_tags(request.item_kind, request.item_id, namespaces)
    return KnowledgeTagLinkResult(
        outcome=outcome, item_kind=request.item_kind, item_id=request.item_id,
        tags=[reference(entry) for entry in tags],
        redirected_to=reference(tag) if named['id'] != tag['id'] else None)


def new_link(space_id: str, tag_id: str, item_kind: str, item_id: str, at, actor_kind: str,
             moved_from_tag_id: str | None = None) -> dict:
    """An attached link record; reattaching a detached or moved one reuses its node."""
    return {'id': tag_link_id(space_id, tag_id, item_kind, item_id), 'space_id': space_id, 'tag_id': tag_id,
            'item_kind': item_kind, 'item_id': item_id, 'status': 'attached', 'attached_at': at,
            'attached_by_kind': actor_kind, 'detached_at': None, 'detached_by_kind': None,
            'moved_to_tag_id': None, 'moved_from_tag_id': moved_from_tag_id}


async def tag_metrics(store, actor: dict, request: KnowledgeTagMetricsQuery) -> KnowledgeTagMetrics:
    space, namespaces = await visible_tag_scope(store, actor, request, 'reader')
    since = datetime.now(timezone.utc) - timedelta(days=request.days)
    counts, created = await store.knowledge_tag_vocabulary().metrics(
        space['id'], None if request.include_all_projects else namespaces, since)
    return KnowledgeTagMetrics(scope='all' if request.include_all_projects else 'visible',
                               days=request.days, counts=counts, created_by_day=created)


def tag_record(tag: dict) -> KnowledgeTagRecord:
    return KnowledgeTagRecord(
        id=tag['id'], name=tag['name'], namespace=tag['namespace_kind'], status=tag['status'],
        description=tag.get('description'), aliases=list(tag['aliases']),
        provisional_aliases=[alias for alias, status in zip(tag['aliases'], tag['alias_statuses'])
                             if status == 'provisional'],
        proposed_aliases=list(tag['proposed_aliases']),
        language=tag.get('language'), version=int(tag['version']),
        source={'kind': tag['source_kind'], 'application': tag.get('source_application'),
                'reason': tag['source_reason']},
        distinct_from=list(tag.get('distinct_from') or []),
        created_at=tag['created_at'], updated_at=tag['updated_at'])


def reference(tag: dict) -> KnowledgeTagReference:
    return KnowledgeTagReference(id=tag['id'], name=tag['name'], namespace=tag['namespace_kind'],
                                 status=tag['status'])


def _new_tag_namespace(request: KnowledgeTagCreate) -> str:
    if request.namespace == 'shared':
        raise HTTPException(status_code=403, detail=_SHARED_REFUSED)
    if request.namespace == 'project' and not request.personal_project_id:
        raise HTTPException(status_code=422, detail='a project tag needs personal_project_id')
    if request.namespace:
        return request.namespace
    # Never widen silently: without a project the caller names the personal scope.
    if not request.personal_project_id:
        raise HTTPException(status_code=422, detail=_NO_CURRENT_PROJECT)
    return 'project'


def _reused(candidates, namespace: str, acknowledged: set[str]):
    """The tag a creation returns instead: same word in its own namespace, or a
    personal tag (visible in every project) the caller did not judge different."""
    keyed = [candidate for candidate in candidates if candidate.match != 'similar']
    own = [candidate for candidate in keyed if candidate.namespace == namespace]
    if own:
        return own[0]
    if namespace == 'project':
        return next((candidate for candidate in keyed if candidate.id not in acknowledged), None)
    return None


def _agent_alias_takes_effect(tag: dict) -> bool:
    # An Agent may grow its own project's provisional tag; an active or personal
    # tag changes meaning for a person or for every project, so it only proposes.
    return tag['namespace_kind'] == 'project' and tag['status'] == 'provisional'


def _with_alias(tag: dict, alias: str, key: str, status: str) -> dict:
    keep = [index for index, proposed in enumerate(tag['proposed_alias_keys']) if proposed != key]
    return {'aliases': [*tag['aliases'], alias], 'alias_keys': [*tag['alias_keys'], key],
            'alias_statuses': [*tag['alias_statuses'], status],
            'proposed_aliases': [tag['proposed_aliases'][index] for index in keep],
            'proposed_alias_keys': [tag['proposed_alias_keys'][index] for index in keep]}


def _confirms_provisional(tag: dict, key: str, operation_actor: str) -> bool:
    return (operation_actor == 'human' and key in tag['alias_keys']
            and tag['alias_statuses'][tag['alias_keys'].index(key)] == 'provisional')


def _with_alias_status(tag: dict, key: str, status: str) -> dict:
    statuses = list(tag['alias_statuses'])
    statuses[tag['alias_keys'].index(key)] = status
    return {'alias_statuses': statuses}


def _held(tag: dict, key: str):
    return (tag_candidate(tag, 'exact', 'name') if tag['name_key'] == key
            else tag_candidate(tag, 'alias', 'alias'))


async def visible_tag_scope(store, actor: dict, request: KnowledgeTagScope, role: str, *,
                            all_projects: bool = False):
    """The caller's space and the namespaces it sees; None means every namespace
    (the owner's console view across projects)."""
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, role)
    namespaces = [PERSONAL_NAMESPACE]
    if request.personal_project_id:
        await authorize_personal_project(store, actor, space, request.personal_project_id)
        namespaces.append(project_namespace(request.personal_project_id))
    return space, None if all_projects else namespaces


async def visible_tag(reader, namespaces: list[str] | None, tag_id: str) -> dict:
    """The tag in any status, if the caller's scope sees its namespace."""
    tag = await reader.get_any(tag_id)
    # Another project's tag is reported exactly like a missing one.
    if tag is None or (namespaces is not None and tag['namespace_key'] not in namespaces):
        raise HTTPException(status_code=404, detail='knowledge tag not found')
    return tag


async def _live_visible_tag(reader, namespaces, tag_id: str) -> tuple[dict, dict]:
    """The named tag and the live tag it means now (itself, or where it was merged)."""
    named = await visible_tag(reader, namespaces, tag_id)
    tag = await live_target(reader, named)
    if tag is None:
        raise HTTPException(status_code=409, detail={'code': 'tag_retired', 'message': _RETIRED,
                                                      'tag': reference(named).model_dump()})
    return named, tag


async def _require_taggable(port, space, request: KnowledgeTagLinkChange) -> None:
    """The item as stored now (read under the lock): unknown, missing, hard-deleted
    and out-of-scope items answer alike."""
    scope = await port.item_scope(space, request.item_kind, request.item_id)
    if not _taggable_here(scope, request.personal_project_id):
        raise HTTPException(status_code=404, detail='knowledge item not found')


def _taggable_here(scope, project_id: str | None) -> bool:
    """Only explicitly global knowledge is taggable everywhere. Project knowledge,
    including knowledge from several projects, only in one of its own projects;
    knowledge of unknown source only in the personal scope, never from a project."""
    if scope is None:
        return False
    kind, project_ids = scope
    if kind == 'global':
        return True
    if kind == 'projects':
        return project_id in project_ids
    return project_id is None


def new_tag_record(*, actor_id: str, space_id: str, namespace: str, project_id: str | None, name: str,
                   name_key: str, description: str | None, language: str | None, actor_kind: str,
                   source_application, reason: str, distinct_from: list[str], at) -> dict:
    """A tag as stored; the person's own starts active, an Agent's provisional."""
    namespace_key = project_namespace(project_id) if namespace == 'project' else PERSONAL_NAMESPACE
    status = 'active' if actor_kind == 'human' else 'provisional'
    return {
        'id': stable_uuid(space_id, 'knowledge-tag', namespace_key, name_key),
        'space_id': space_id, 'namespace_kind': namespace,
        'namespace_project_id': project_id if namespace == 'project' else None,
        'namespace_key': namespace_key, 'name': name, 'name_key': name_key,
        'description': description, 'language': language,
        'aliases': [], 'alias_keys': [], 'alias_statuses': [],
        'proposed_aliases': [], 'proposed_alias_keys': [], 'parent_ids': [], 'related_ids': [],
        'status': status, 'initial_status': status,
        'source_kind': actor_kind, 'source_application': source_application, 'source_reason': reason,
        'distinct_from': distinct_from, 'created_by': actor_id, 'created_at': at, 'updated_at': at, 'version': 1,
    }


def _new_tag(actor, space_id, request: KnowledgeTagCreate, namespace, name_key, seen_ids):
    return new_tag_record(
        actor_id=actor['id'], space_id=space_id, namespace=namespace, project_id=request.personal_project_id,
        name=request.name, name_key=name_key, description=request.description, language=request.language,
        actor_kind=request.operation_actor, source_application=request.source_application,
        reason=request.reason,
        # Only the candidates actually judged are recorded as different.
        distinct_from=sorted(set(request.distinct_from) & seen_ids), at=now_utc())


def _revision(tag: dict, action: str, request, created_at, *, alias=None, alias_status=None,
              similarity_version=None) -> dict:
    """One history entry; the port stamps the tag version it produced."""
    return {
        'id': stable_uuid(tag['space_id'], 'knowledge-tag-revision', tag['id'], action,
                          alias or '', created_at.isoformat()),
        'space_id': tag['space_id'], 'tag_id': tag['id'], 'action': action, 'alias': alias,
        'alias_status': alias_status, 'similarity_version': similarity_version,
        'reason': request.reason, 'actor_kind': request.operation_actor,
        'source_application': request.source_application, 'created_at': created_at,
    }


def tag_link_id(space_id: str, tag_id: str, item_kind: str, item_id: str) -> str:
    return stable_uuid(space_id, 'knowledge-tag-link', tag_id, item_kind, item_id)
