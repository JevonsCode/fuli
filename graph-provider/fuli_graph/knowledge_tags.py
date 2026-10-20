"""Reuse a tag before creating one (rec#5 section 3, Graphify G4).

Tags only help find knowledge. Nothing here reads or changes an item's content,
confirmation, authority or evidence, and a tag never widens what a caller may
see: the visible vocabulary is the personal one plus the current project's.
Similar tags are returned as candidates and never merged; a synonym becomes the
same tag only through an explicit alias.
"""
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from .knowledge_tag_models import (
    KnowledgeTagAliasCreate,
    KnowledgeTagAliasResult,
    KnowledgeTagCandidate,
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
from .name_identity import identity_key
from .personal_project_access import authorize_personal_project
from .provider_values import now_utc, stable_uuid

PERSONAL_NAMESPACE = 'personal'
# Bounds the similarity scan; exact and alias matches are looked up by key.
MAX_SCANNED_TAGS = 2000
MAX_TAGS_PER_ITEM = 32
# A decision shows a few candidates at a time, never the whole vocabulary.
MAX_DECISION_CANDIDATES = 5
# Cosine of the provider's local-hash embedding over name and aliases. It is
# lexical (shared character n-grams) and only ever proposes a candidate. Random
# unrelated 16-character names reach about 0.32 through hash collisions, so the
# bar sits above that noise; containment of one name in another is checked
# separately and exactly.
SIMILARITY_THRESHOLD = 0.35
MIN_CONTAINED_NAME = 2
_MATCH_ORDER = {'exact': 0, 'alias': 1, 'similar': 2}
_NEEDS_DECISION = ('Similar tags exist. Reuse one (attach it, or add_alias if your word is a synonym), '
                   'or create again with distinctFrom naming each candidate you judged different.')
_SHARED_REFUSED = 'shared vocabulary changes need governance and are not available yet'


def project_namespace(project_id: str) -> str:
    return f'project:{project_id}'


async def resolve_tags(store, actor: dict, request: KnowledgeTagResolve) -> KnowledgeTagResolveResult:
    space, namespaces = await _visible_scope(store, actor, request, 'reader')
    candidates = await _candidates(store, space['id'], namespaces, request.query)
    return KnowledgeTagResolveResult(query=request.query, candidates=candidates[:request.limit])


async def create_tag(store, actor: dict, request: KnowledgeTagCreate) -> KnowledgeTagCreateResult:
    if request.namespace == 'shared':
        raise HTTPException(status_code=403, detail=_SHARED_REFUSED)
    namespace = request.namespace or ('project' if request.personal_project_id else 'personal')
    if namespace == 'project' and not request.personal_project_id:
        raise HTTPException(status_code=422, detail='a project tag needs personal_project_id')
    space, namespaces = await _visible_scope(store, actor, request, 'maintainer')
    candidates = await _candidates(store, space['id'], namespaces, request.name)
    reusable = [candidate for candidate in candidates if candidate.match != 'similar']
    if reusable:
        return await _existing(store, space['id'], reusable[0].id, candidates)
    undecided = [candidate for candidate in candidates if candidate.id not in request.distinct_from]
    if undecided:
        return KnowledgeTagCreateResult(outcome='needs_decision', tag=None,
                                        candidates=undecided[:MAX_DECISION_CANDIDATES],
                                        guidance=_NEEDS_DECISION)
    namespace_key = (project_namespace(request.personal_project_id)
                     if namespace == 'project' else PERSONAL_NAMESPACE)
    tag = _new_tag(actor, space['id'], request, namespace, namespace_key,
                   [candidate.id for candidate in candidates])
    stored, created = await store.knowledge_tag_vocabulary().create(
        space['id'], tag, namespaces, _revision(tag, 'create', request, tag['created_at']))
    return KnowledgeTagCreateResult(outcome='created' if created else 'existing',
                                    tag=tag_record(stored), candidates=[])


async def add_tag_alias(store, actor: dict, request: KnowledgeTagAliasCreate) -> KnowledgeTagAliasResult:
    space, namespaces = await _visible_scope(store, actor, request, 'maintainer')
    tag = await _visible_tag(store, space['id'], namespaces, request.tag_id)
    alias_key = identity_key(request.alias)
    outcome, value = await store.knowledge_tag_vocabulary().add_alias(
        space['id'], tag['id'], request.alias, alias_key, namespaces,
        _revision(tag, 'add_alias', request, now_utc(), alias=request.alias))
    if outcome == 'conflict':
        # The word already names another visible tag; an alias never makes two tags one.
        held = ('exact', 'name') if value['name_key'] == alias_key else ('alias', 'alias')
        return KnowledgeTagAliasResult(outcome=outcome, tag=tag_record(tag),
                                       conflict=_candidate(value, *held))
    return KnowledgeTagAliasResult(outcome=outcome, tag=tag_record(value))


async def attach_tag(store, actor: dict, request: KnowledgeTagLinkChange) -> KnowledgeTagLinkResult:
    space, namespaces, tag = await _link_scope(store, actor, request)
    at = now_utc()
    outcome = await store.knowledge_tag_vocabulary().attach(space['id'], {
        'id': _link_id(space['id'], tag['id'], request), 'space_id': space['id'], 'tag_id': tag['id'],
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
        space['id'], _link_id(space['id'], tag['id'], request), now_utc(), request.operation_actor)
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
        description=tag.get('description'), aliases=list(tag.get('aliases') or []),
        language=tag.get('language'), version=int(tag['version']),
        source={'kind': tag['source_kind'], 'application': tag.get('source_application'),
                'reason': tag['source_reason']},
        distinct_from=list(tag.get('distinct_from') or []),
        created_at=tag['created_at'], updated_at=tag['updated_at'])


async def _visible_scope(store, actor: dict, request: KnowledgeTagScope, role: str):
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, role)
    namespaces = [PERSONAL_NAMESPACE]
    if request.personal_project_id:
        await authorize_personal_project(store, actor, space, request.personal_project_id)
        namespaces.append(project_namespace(request.personal_project_id))
    return space, namespaces


async def _candidates(store, space_id: str, namespaces: list[str], text: str):
    """Exact name, then alias, then similar; each tag once, its strongest match."""
    key = identity_key(text)
    vocabulary = store.knowledge_tag_vocabulary()
    found = {}
    for tag in await vocabulary.find_by_key(space_id, namespaces, key):
        found[tag['id']] = (_candidate(tag, 'exact', 'name') if tag['name_key'] == key
                            else _candidate(tag, 'alias', 'alias'))
    scanned = [tag for tag in await vocabulary.list_visible(space_id, namespaces, MAX_SCANNED_TAGS)
               if tag['id'] not in found]
    for tag, basis in await _similar(store, key, scanned):
        found[tag['id']] = _candidate(tag, 'similar', basis)
    return sorted(found.values(), key=lambda candidate: (
        _MATCH_ORDER[candidate.match], candidate.status != 'active', identity_key(candidate.name)))


async def _similar(store, key: str, tags: list[dict]):
    lexical = [(tag, basis) for tag in tags if (basis := _lexical_basis(key, tag))]
    described = {tag['id'] for tag, _ in lexical}
    rest = [tag for tag in tags if tag['id'] not in described]
    if not rest:
        return lexical
    texts = [key, *(' '.join([tag['name_key'], *tag['alias_keys']]) for tag in rest)]
    query, *vectors = await store.runtime.embedder.create_batch(texts)
    semantic = [(tag, 'semantic') for tag, vector in zip(rest, vectors)
                if sum(left * right for left, right in zip(query, vector)) >= SIMILARITY_THRESHOLD]
    return lexical + semantic


def _lexical_basis(key: str, tag: dict) -> str | None:
    if any(min(len(key), len(name)) >= MIN_CONTAINED_NAME and (key in name or name in key)
           for name in [tag['name_key'], *tag['alias_keys']]):
        return 'name'
    return 'description' if key in identity_key(tag.get('description') or '') else None


def _candidate(tag: dict, match: str, basis: str) -> KnowledgeTagCandidate:
    return KnowledgeTagCandidate(
        id=tag['id'], name=tag['name'], namespace=tag['namespace_kind'], status=tag['status'],
        match=match, basis=basis, description=tag.get('description'),
        aliases=list(tag.get('aliases') or []))


async def _existing(store, space_id, tag_id, candidates):
    tag = await store.knowledge_tag_vocabulary().get(space_id, tag_id)
    others = [candidate for candidate in candidates if candidate.id != tag_id]
    return KnowledgeTagCreateResult(outcome='existing', tag=tag_record(tag),
                                    candidates=others[:MAX_DECISION_CANDIDATES])


async def _visible_tag(store, space_id: str, namespaces: list[str], tag_id: str) -> dict:
    tag = await store.knowledge_tag_vocabulary().get(space_id, tag_id)
    # Another project's tag is reported exactly like a missing one.
    if tag is None or tag['namespace_key'] not in namespaces:
        raise HTTPException(status_code=404, detail='knowledge tag not found')
    return tag


async def _link_scope(store, actor: dict, request: KnowledgeTagLinkChange):
    space, namespaces = await _visible_scope(store, actor, request, 'maintainer')
    tag = await _visible_tag(store, space['id'], namespaces, request.tag_id)
    found, owner = await store.knowledge_tag_vocabulary().item_project(
        space, request.item_kind, request.item_id)
    # Global knowledge is visible everywhere; project knowledge only in its project.
    if not found or owner not in (None, request.personal_project_id):
        raise HTTPException(status_code=404, detail='knowledge item not found')
    return space, namespaces, tag


async def _link_result(store, space_id, namespaces, request, outcome) -> KnowledgeTagLinkResult:
    tags = await store.knowledge_tag_vocabulary().item_tags(
        space_id, request.item_kind, request.item_id, namespaces)
    return KnowledgeTagLinkResult(
        outcome=outcome, item_kind=request.item_kind, item_id=request.item_id,
        tags=[KnowledgeTagReference(id=tag['id'], name=tag['name'], namespace=tag['namespace_kind'],
                                    status=tag['status']) for tag in tags])


def _new_tag(actor, space_id, request: KnowledgeTagCreate, namespace, namespace_key, seen_ids):
    created_at = now_utc()
    name_key = identity_key(request.name)
    status = 'active' if request.operation_actor == 'human' else 'provisional'
    return {
        'id': stable_uuid(space_id, 'knowledge-tag', namespace_key, name_key),
        'space_id': space_id, 'namespace_kind': namespace,
        'namespace_project_id': request.personal_project_id if namespace == 'project' else None,
        'namespace_key': namespace_key, 'name': request.name, 'name_key': name_key,
        'description': request.description, 'language': request.language,
        'aliases': [], 'alias_keys': [], 'status': status, 'initial_status': status,
        'source_kind': request.operation_actor, 'source_application': request.source_application,
        'source_reason': request.reason,
        # Only the candidates actually shown are recorded as judged different.
        'distinct_from': sorted(set(request.distinct_from) & set(seen_ids)),
        'created_by': actor['id'], 'created_at': created_at, 'updated_at': created_at, 'version': 1,
    }


def _revision(tag: dict, action: str, request, created_at, *, alias=None) -> dict:
    """One history entry; the port stamps the tag version it produced."""
    return {
        'id': stable_uuid(tag['space_id'], 'knowledge-tag-revision', tag['id'], action,
                          alias or '', created_at.isoformat()),
        'space_id': tag['space_id'], 'tag_id': tag['id'], 'action': action, 'alias': alias,
        'reason': request.reason, 'actor_kind': request.operation_actor,
        'source_application': request.source_application, 'created_at': created_at,
    }


def _link_id(space_id: str, tag_id: str, request: KnowledgeTagLinkChange) -> str:
    return stable_uuid(space_id, 'knowledge-tag-link', tag_id, request.item_kind, request.item_id)
