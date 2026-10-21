"""Reuse a tag before creating one (rec#5 section 3, Graphify G4).

Tags only help find knowledge. Nothing here reads or changes an item's content,
confirmation, authority or evidence, and a tag never widens what a caller may
see: the visible vocabulary is the personal one plus the current project's.
Similar tags are returned as candidates and never merged; a synonym becomes the
same tag only through an explicit alias. Every create and alias is decided and
written under the personal space's lock, so concurrent near-duplicates are
judged one after the other (G4-4).
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
from .knowledge_tag_similarity import (
    decision_candidate,
    find_candidates,
    similarity_version,
    tag_candidate,
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


def project_namespace(project_id: str) -> str:
    return f'project:{project_id}'


async def resolve_tags(store, actor: dict, request: KnowledgeTagResolve) -> KnowledgeTagResolveResult:
    space, namespaces = await _visible_scope(store, actor, request, 'reader')
    candidates = await find_candidates(
        store, store.knowledge_tag_vocabulary().reader(space['id']), identity_key(request.query),
        key_namespaces=namespaces, scan_namespaces=namespaces)
    return KnowledgeTagResolveResult(query=request.query, candidates=candidates.found[:request.limit],
                                     truncated=candidates.truncated,
                                     similarity_version=similarity_version(store))


async def create_tag(store, actor: dict, request: KnowledgeTagCreate) -> KnowledgeTagCreateResult:
    namespace = _new_tag_namespace(request)
    space, visible = await _visible_scope(store, actor, request, 'maintainer')
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
                outcome='existing', tag=tag_record(await vocabulary.get(reused.id)),
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
        stored = await vocabulary.insert(tag, _revision(
            tag, 'create', request, tag['created_at'], similarity_version=version))
    return KnowledgeTagCreateResult(outcome='created', tag=tag_record(stored), candidates=[], **decided)


async def add_tag_alias(store, actor: dict, request: KnowledgeTagAliasCreate) -> KnowledgeTagAliasResult:
    space, namespaces = await _visible_scope(store, actor, request, 'maintainer')
    key = identity_key(request.alias)
    async with store.knowledge_tag_vocabulary().locked(space['id']) as vocabulary:
        tag = await _visible_tag(vocabulary, namespaces, request.tag_id)
        if key == tag['name_key'] or key in tag['alias_keys']:
            if not _confirms_provisional(tag, key, request.operation_actor):
                return KnowledgeTagAliasResult(outcome='unchanged', tag=tag_record(tag), normalized=key)
            # A person adding an Agent's provisional alias accepts it: same entry, now active.
            stored = await vocabulary.save_aliases(tag['id'], _with_alias_status(tag, key, 'active'),
                                                   _revision(tag, 'confirm_alias', request, now_utc(),
                                                             alias=request.alias, alias_status='active'))
            return KnowledgeTagAliasResult(outcome='added', tag=tag_record(stored), normalized=key)
        holders = [other for other in await vocabulary.find_by_key(namespaces, key)
                   if other['id'] != tag['id']]
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
        stored = await vocabulary.save_aliases(tag['id'], fields, _revision(
            tag, 'add_alias' if outcome == 'added' else 'propose_alias', request, now_utc(),
            alias=request.alias, alias_status=status))
    return KnowledgeTagAliasResult(outcome=outcome, tag=tag_record(stored), normalized=key,
                                   guidance=_ALIAS_PROPOSED if outcome == 'proposed' else None)


async def attach_tag(store, actor: dict, request: KnowledgeTagLinkChange) -> KnowledgeTagLinkResult:
    space, namespaces, tag = await _link_scope(store, actor, request)
    at = now_utc()
    outcome = await store.knowledge_tag_vocabulary().attach(space['id'], {
        'id': tag_link_id(space['id'], tag['id'], request.item_kind, request.item_id),
        'space_id': space['id'], 'tag_id': tag['id'],
        'item_kind': request.item_kind, 'item_id': request.item_id, 'status': 'attached',
        'attached_at': at, 'attached_by_kind': request.operation_actor, 'detached_at': None,
    }, MAX_TAGS_PER_ITEM)
    if outcome == 'limit':
        raise HTTPException(status_code=409,
                            detail=f'a knowledge item carries at most {MAX_TAGS_PER_ITEM} tags')
    return await _link_result(store, space['id'], namespaces, request, outcome)


async def detach_tag(store, actor: dict, request: KnowledgeTagLinkChange) -> KnowledgeTagLinkResult:
    space, namespaces, tag = await _link_scope(store, actor, request)
    outcome = await store.knowledge_tag_vocabulary().detach(
        space['id'], tag_link_id(space['id'], tag['id'], request.item_kind, request.item_id), now_utc(),
        request.operation_actor)
    return await _link_result(store, space['id'], namespaces, request, outcome)


async def tag_metrics(store, actor: dict, request: KnowledgeTagMetricsQuery) -> KnowledgeTagMetrics:
    space, namespaces = await _visible_scope(store, actor, request, 'reader')
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


async def _visible_scope(store, actor: dict, request: KnowledgeTagScope, role: str):
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, role)
    namespaces = [PERSONAL_NAMESPACE]
    if request.personal_project_id:
        await authorize_personal_project(store, actor, space, request.personal_project_id)
        namespaces.append(project_namespace(request.personal_project_id))
    return space, namespaces


async def _visible_tag(reader, namespaces: list[str], tag_id: str) -> dict:
    tag = await reader.get(tag_id)
    # Another project's tag is reported exactly like a missing one.
    if tag is None or tag['namespace_key'] not in namespaces:
        raise HTTPException(status_code=404, detail='knowledge tag not found')
    return tag


async def _link_scope(store, actor: dict, request: KnowledgeTagLinkChange):
    space, namespaces = await _visible_scope(store, actor, request, 'maintainer')
    vocabulary = store.knowledge_tag_vocabulary()
    tag = await _visible_tag(vocabulary.reader(space['id']), namespaces, request.tag_id)
    scope = await vocabulary.item_scope(space, request.item_kind, request.item_id)
    # Unknown, missing and out-of-scope items answer alike.
    if not _taggable_here(scope, request.personal_project_id):
        raise HTTPException(status_code=404, detail='knowledge item not found')
    return space, namespaces, tag


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


async def _link_result(store, space_id, namespaces, request, outcome) -> KnowledgeTagLinkResult:
    tags = await store.knowledge_tag_vocabulary().item_tags(
        space_id, request.item_kind, request.item_id, namespaces)
    return KnowledgeTagLinkResult(
        outcome=outcome, item_kind=request.item_kind, item_id=request.item_id,
        tags=[KnowledgeTagReference(id=tag['id'], name=tag['name'], namespace=tag['namespace_kind'],
                                    status=tag['status']) for tag in tags])


def _new_tag(actor, space_id, request: KnowledgeTagCreate, namespace, name_key, seen_ids):
    created_at = now_utc()
    namespace_key = (project_namespace(request.personal_project_id)
                     if namespace == 'project' else PERSONAL_NAMESPACE)
    status = 'active' if request.operation_actor == 'human' else 'provisional'
    return {
        'id': stable_uuid(space_id, 'knowledge-tag', namespace_key, name_key),
        'space_id': space_id, 'namespace_kind': namespace,
        'namespace_project_id': request.personal_project_id if namespace == 'project' else None,
        'namespace_key': namespace_key, 'name': request.name, 'name_key': name_key,
        'description': request.description, 'language': request.language,
        'aliases': [], 'alias_keys': [], 'alias_statuses': [],
        'proposed_aliases': [], 'proposed_alias_keys': [],
        'status': status, 'initial_status': status,
        'source_kind': request.operation_actor, 'source_application': request.source_application,
        'source_reason': request.reason,
        # Only the candidates actually judged are recorded as different.
        'distinct_from': sorted(set(request.distinct_from) & seen_ids),
        'created_by': actor['id'], 'created_at': created_at, 'updated_at': created_at, 'version': 1,
    }


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
