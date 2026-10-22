"""The person's governance of the tag vocabulary (rec#5 G4-5, rec#11 D-07 part 2).

Approving a provisional tag, merging, splitting, retiring, removing an alias,
relating tags and undoing any of these are the person's decisions. Anyone who
sees a tag may preview a change, an Agent included; only the human-review
channel applies one, naming the digest of the preview the person confirmed, so
a vocabulary that changed in between refuses instead of doing something else.

- Merge A into B: A becomes merged with a redirect to B and never resolves
  again; its attached links move to B, an item already tagged B keeps one link;
  A's children, parents and related tags carry over to B unless that would make
  a parent cycle, point B at itself or give a personal tag a project parent.
  B is in A's namespace or personal, so B is visible wherever A was.
- Split S: the chosen aliases and links move to a new tag in S's namespace, or
  back to a tag that was merged into S or retired, which comes back (G4-5).
- Undo: every change records the before-state of each tag and link it wrote
  and the versions it left them at. Undo restores that state exactly when none
  of them changed since; a tag the change created is retired. Nothing is deleted.
- Parents never form a cycle; a personal tag's parent is personal; related
  tags are symmetric and never join two projects.

Every change runs in one transaction under the space's knowledge lock and
records a revision on each tag it touched.
"""
import json
from dataclasses import dataclass, field
from datetime import datetime
from uuid import uuid4

from fastapi import HTTPException

from .knowledge_tag_governance_models import (
    KnowledgeTagBlocked,
    KnowledgeTagGovernanceApply,
    KnowledgeTagGovernancePreview,
    KnowledgeTagGovernanceRequest,
    KnowledgeTagGovernanceResult,
    KnowledgeTagRelationDrop,
    KnowledgeTagUndoPreview,
)
from .knowledge_tag_models import LIVE_STATUSES
from .knowledge_tag_relations import (
    MAX_PARENTS,
    MAX_RELATED,
    carry_relations,
    other_tag,
    relate,
    unrelate,
)
from .knowledge_tags import (
    PERSONAL_NAMESPACE,
    new_link,
    new_tag_record,
    reference,
    tag_link_id,
    visible_tag,
    visible_tag_scope,
)
from .name_identity import identity_key
from .provider_values import now_utc, sha256_text, stable_uuid

# What a change may set on a tag, and so what its undo restores.
GOVERNED_FIELDS = ('status', 'merged_into_id', 'aliases', 'alias_keys', 'alias_statuses',
                   'proposed_aliases', 'proposed_alias_keys', 'parent_ids', 'related_ids')
LINK_FIELDS = ('status', 'attached_at', 'attached_by_kind', 'detached_at', 'detached_by_kind',
               'moved_to_tag_id', 'moved_from_tag_id')
_LINK_TIMES = frozenset({'attached_at', 'detached_at'})
_SCALAR_FIELDS = frozenset({'status', 'merged_into_id'})
_PRIMARY_ACTION = {'approve': 'approve', 'merge': 'merge', 'split': 'split', 'retire': 'retire',
                   'remove_alias': 'remove_alias', 'relate': 'relate', 'unrelate': 'unrelate', 'undo': 'undo'}
_SECONDARY_ACTION = {'merge': 'merge_in', 'split': 'split_from', 'relate': 'relate', 'unrelate': 'unrelate',
                     'undo': 'undo'}
_MESSAGES = {
    'not_provisional': 'Only a provisional tag waits for approval.',
    'not_live': 'This tag is merged or retired; undo that change first.',
    'self': 'A tag cannot be merged into or related to itself.',
    'scope': 'A tag merges into, or takes as parent, only a tag of its own namespace or a personal '
             'one; related tags never join two projects.',
    'parent_cycle': 'That parent would make the tag its own ancestor.',
    'too_many': f'A tag has at most {MAX_PARENTS} parents and {MAX_RELATED} related tags.',
    'unchanged': 'Nothing would change.',
    'alias_not_on_tag': 'Choose aliases the tag holds now.',
    'link_not_on_tag': 'Choose items the tag is attached to now.',
    'nothing_to_split': 'Choose at least one alias or item to move to the new tag.',
    'name_in_use': 'Another tag already holds this name; merge into it or choose another name.',
    'nothing_to_undo': 'This tag has no change left to undo.',
    'already_undone': 'This change was already undone.',
    'changed_since': 'Tags or links this change wrote changed since; undo the later change first.',
}


async def preview_governance(store, actor: dict, request: KnowledgeTagGovernanceRequest
                             ) -> KnowledgeTagGovernancePreview:
    space, namespaces = await visible_tag_scope(store, actor, request, 'reader',
                                                all_projects=request.include_all_projects)
    plan = await _plan(store.knowledge_tag_vocabulary().reader(space['id']), space, namespaces, request,
                       actor['id'], reason='')
    return plan.preview


async def apply_governance(store, actor: dict, request: KnowledgeTagGovernanceApply
                           ) -> KnowledgeTagGovernanceResult:
    """Only on the human-review channel (the route's HumanReviewer); this refuses
    any other caller of the function as well."""
    if actor.get('_human_review_verified') is not True:
        raise HTTPException(status_code=403, detail='independent human review proof required')
    space, namespaces = await visible_tag_scope(store, actor, request, 'maintainer',
                                                all_projects=request.include_all_projects)
    async with store.knowledge_tag_vocabulary().locked(space['id']) as vocabulary:
        plan = await _plan(vocabulary, space, namespaces, request, actor['id'], reason=request.reason)
        if plan.preview.blocked:
            raise HTTPException(status_code=409, detail=plan.preview.blocked.model_dump())
        if plan.preview.digest != request.preview_digest:
            raise HTTPException(status_code=409, detail={
                'code': 'preview_stale', 'message': 'The vocabulary changed since this preview; check it again.',
                'preview': plan.preview.model_dump(mode='json')})
        written = await vocabulary.apply(**plan.writes(request.reason))
    touched = {**plan.tags, **written}
    return KnowledgeTagGovernanceResult(
        change=request.change, operation_id=plan.operation_id, preview=plan.preview,
        tags=[reference(touched[tag_id]) for tag_id in plan.touched_order
              if namespaces is None or touched[tag_id]['namespace_key'] in namespaces])


@dataclass
class _Plan:
    """One change computed from what is stored now: the writes and the preview."""
    space_id: str
    tags: dict
    namespaces: list | None
    change: str
    subject_id: str
    actor_id: str
    at: object
    operation_id: str = field(default_factory=lambda: str(uuid4()))
    updates: dict = field(default_factory=dict)
    before: dict = field(default_factory=dict)
    new_tags: dict = field(default_factory=dict)
    links: dict = field(default_factory=dict)
    before_links: dict = field(default_factory=dict)
    # Versions of what the change read and wrote: the preview digest binds them.
    basis: dict = field(default_factory=dict)
    touched_order: list = field(default_factory=list)
    other_id: str | None = None
    undoes: str | None = None
    preview: KnowledgeTagGovernancePreview | None = None
    summary: dict = field(default_factory=dict)

    def current(self, tag_id: str) -> dict:
        tag = self.new_tags.get(tag_id) or self.tags[tag_id]
        return {**tag, **self.updates.get(tag_id, {})}

    def live(self, tag_id: str) -> bool:
        known = tag_id in self.tags or tag_id in self.new_tags
        return known and self.current(tag_id)['status'] in LIVE_STATUSES

    def visible(self, tag_id: str) -> bool:
        return self.namespaces is None or self.current(tag_id)['namespace_key'] in self.namespaces

    def read(self, tag_id: str) -> dict:
        tag = self.current(tag_id)
        self.basis[f'tag:{tag_id}'] = tag['version']
        return tag

    def update(self, tag_id: str, **fields) -> None:
        if tag_id not in self.before and tag_id not in self.new_tags:
            stored = self.tags[tag_id]
            self.before[tag_id] = governed_state(stored)
            self.basis[f'tag:{tag_id}'] = stored['version']
        self.updates.setdefault(tag_id, {}).update(fields)
        self._touch(tag_id)

    def create(self, tag: dict) -> None:
        self.new_tags[tag['id']] = tag
        self.basis[f'new:{tag["id"]}'] = tag['name_key']
        self._touch(tag['id'])

    def write_link(self, link: dict, stored: dict | None) -> None:
        if link['id'] not in self.before_links:
            self.before_links[link['id']] = None if stored is None else _link_snapshot(stored)
            self.basis[f'link:{link["id"]}'] = None if stored is None else stored.get('version')
        self.links[link['id']] = {**(stored or {}), **link}
        self.links[link['id']].pop('version', None)

    def _touch(self, tag_id: str) -> None:
        if tag_id not in self.touched_order:
            self.touched_order.append(tag_id)

    def parents(self, tag_id: str) -> list[str]:
        return [parent for parent in self.current(tag_id).get('parent_ids') or [] if self.live(parent)]

    def creates_cycle(self, child: str, parent: str) -> bool:
        """Whether `parent` taking `child` would make child its own ancestor."""
        seen, pending = set(), [parent]
        while pending:
            tag_id = pending.pop()
            if tag_id == child:
                return True
            if tag_id not in seen:
                seen.add(tag_id)
                pending.extend(self.parents(tag_id))
        return False

    def writes(self, reason: str) -> dict:
        # The undo record: each written tag's and link's state before and after.
        # An undo restores `before` only while the stored state is still `after`.
        snapshot = None if self.change == 'undo' else json.dumps({
            'tags': {tag_id: {'before': self.before.get(tag_id), 'after': governed_state(self.current(tag_id))}
                     for tag_id in self.touched_order},
            'links': {link_id: {'before': before, 'after': _link_snapshot(self.links[link_id])}
                      for link_id, before in self.before_links.items()},
        }, ensure_ascii=False, sort_keys=True, default=str)
        revisions = [self._revision(tag_id, reason, snapshot if tag_id == self.subject_id else None)
                     for tag_id in self.touched_order]
        return {'new_tags': [{**tag, **self.updates.get(tag_id, {})} for tag_id, tag in self.new_tags.items()],
                'updates': [{'id': tag_id, 'at': self.at, 'fields': fields}
                            for tag_id, fields in self.updates.items() if tag_id not in self.new_tags],
                'links': list(self.links.values()), 'revisions': revisions}

    def _revision(self, tag_id: str, reason: str, snapshot: str | None) -> dict:
        if tag_id == self.subject_id:
            action, other = _PRIMARY_ACTION[self.change], self.other_id
        elif self.change == 'undo':
            action, other = 'undo', self.subject_id
        elif tag_id == self.other_id:
            action, other = _SECONDARY_ACTION.get(self.change, 'relation_moved'), self.subject_id
        else:
            # A child, parent or related tag a merge re-pointed at the merged-into tag.
            action, other = 'relation_moved', self.other_id
        return {'id': stable_uuid(self.space_id, 'knowledge-tag-revision', tag_id, self.operation_id),
                'space_id': self.space_id, 'tag_id': tag_id, 'action': action, 'reason': reason,
                'actor_kind': 'human', 'source_application': None, 'created_at': self.at,
                'operation_id': self.operation_id, 'related_tag_id': other,
                'relation': self.summary.get('relation'), 'alias': self.summary.get('alias'),
                'snapshot_json': snapshot, 'undoes_operation_id': self.undoes}


async def _plan(reader, space, namespaces, request: KnowledgeTagGovernanceRequest, actor_id: str, *,
                reason: str) -> _Plan:
    subject = await visible_tag(reader, namespaces, request.tag_id)
    tags = {tag['id']: tag for tag in await reader.all_tags()}
    plan = _Plan(space_id=space['id'], tags=tags, namespaces=namespaces, change=request.change,
                 subject_id=subject['id'], actor_id=actor_id, at=now_utc())
    plan.read(subject['id'])
    blocked = await _PLANNERS[request.change](plan, reader, request, reason)
    plan.preview = _preview(plan, request, blocked)
    return plan


async def _approve(plan: _Plan, reader, request, reason):
    if plan.current(plan.subject_id)['status'] != 'provisional':
        return 'not_provisional'
    plan.update(plan.subject_id, status='active')
    plan.summary['status_after'] = 'active'


async def _retire(plan: _Plan, reader, request, reason):
    if not plan.live(plan.subject_id):
        return 'not_live'
    plan.update(plan.subject_id, status='retired')
    plan.summary['status_after'] = 'retired'


async def _remove_alias(plan: _Plan, reader, request, reason):
    if not plan.live(plan.subject_id):
        return 'not_live'
    tag, key = plan.current(plan.subject_id), identity_key(request.alias)
    plan.summary.update(alias=request.alias, aliases=[request.alias])
    if key in tag['alias_keys']:
        keep = [index for index, alias_key in enumerate(tag['alias_keys']) if alias_key != key]
        plan.update(plan.subject_id, **{name: [tag[name][index] for index in keep]
                                        for name in ('aliases', 'alias_keys', 'alias_statuses')})
    elif key in tag['proposed_alias_keys']:
        keep = [index for index, alias_key in enumerate(tag['proposed_alias_keys']) if alias_key != key]
        plan.update(plan.subject_id, **{name: [tag[name][index] for index in keep]
                                        for name in ('proposed_aliases', 'proposed_alias_keys')})
    else:
        return 'alias_not_on_tag'


async def _merge(plan: _Plan, reader, request, reason):
    source = plan.current(plan.subject_id)
    target = await other_tag(plan, reader, request.into_tag_id)
    if not plan.live(source['id']) or not plan.live(target['id']):
        return 'not_live'
    if source['id'] == target['id']:
        return 'self'
    if target['namespace_key'] not in (PERSONAL_NAMESPACE, source['namespace_key']):
        return 'scope'
    plan.update(source['id'], status='merged', merged_into_id=target['id'])
    # B takes A's meaning: a new version of B, so a later change of B blocks this undo.
    plan.update(target['id'])
    plan.summary['status_after'] = 'merged'
    carry_relations(plan, source['id'], target['id'])
    moved = duplicates = 0
    links = await reader.links_of([source['id']])
    targets = await reader.links_by_ids([tag_link_id(plan.space_id, target['id'], link['item_kind'],
                                                      link['item_id']) for link in links])
    for link in links:
        plan.write_link({**link, 'status': 'moved', 'moved_to_tag_id': target['id'], 'detached_at': plan.at,
                         'detached_by_kind': 'human'}, link)
        landing = targets.get(tag_link_id(plan.space_id, target['id'], link['item_kind'], link['item_id']))
        if landing is not None and landing['status'] == 'attached':
            duplicates += 1
            plan.basis[f'link:{landing["id"]}'] = landing['version']
            continue
        plan.write_link(new_link(plan.space_id, target['id'], link['item_kind'], link['item_id'], plan.at,
                                 'human', moved_from_tag_id=source['id']), landing)
        moved += 1
    plan.summary.update(links_moved=moved, links_already_on_target=duplicates)


async def _split(plan: _Plan, reader, request, reason):
    source = plan.current(plan.subject_id)
    if not plan.live(source['id']):
        return 'not_live'
    spec = request.split
    key = identity_key(spec.name)
    alias_keys = []
    for alias in spec.aliases:
        alias_key = identity_key(alias)
        if alias_key not in source['alias_keys']:
            return 'alias_not_on_tag'
        if alias_key != key and alias_key not in alias_keys:
            alias_keys.append(alias_key)
    attached = {(link['item_kind'], link['item_id']): link for link in await reader.links_of([source['id']])}
    chosen = []
    for ref in spec.links:
        link = attached.get((ref.item_kind, ref.item_id))
        if link is None:
            return 'link_not_on_tag'
        if link not in chosen:
            chosen.append(link)
    if not alias_keys and not chosen and key not in source['alias_keys']:
        return 'nothing_to_split'
    moving_keys = set(alias_keys) | ({key} if key in source['alias_keys'] else set())
    earlier = next((tag for tag in plan.tags.values() if tag['namespace_key'] == source['namespace_key']
                    and tag['name_key'] == key), None)
    revives = earlier is not None and (earlier['status'] == 'retired' or (
        earlier['status'] == 'merged' and earlier.get('merged_into_id') == source['id']))
    if earlier is not None and not revives:
        return 'name_in_use'
    holders = _holders(plan, [PERSONAL_NAMESPACE, source['namespace_key']], key,
                       besides=earlier['id'] if revives else None)
    if any(holder != source['id'] or key not in moving_keys for holder in holders):
        return 'name_in_use'
    moved_aliases = [(source['aliases'][source['alias_keys'].index(alias_key)], alias_key)
                     for alias_key in alias_keys]
    keep = [index for index, alias_key in enumerate(source['alias_keys']) if alias_key not in moving_keys]
    plan.update(source['id'], **{name: [source[name][index] for index in keep]
                                 for name in ('aliases', 'alias_keys', 'alias_statuses')})
    if revives:
        plan.read(earlier['id'])
        kept = [index for index, alias_key in enumerate(earlier['alias_keys'])
                if alias_key not in moving_keys and alias_key not in source['alias_keys']]
        new_id = earlier['id']
        plan.update(new_id, status='active', merged_into_id=None, parent_ids=[], related_ids=[],
                    aliases=[*[earlier['aliases'][index] for index in kept], *[alias for alias, _ in moved_aliases]],
                    alias_keys=[*[earlier['alias_keys'][index] for index in kept], *alias_keys],
                    alias_statuses=[*[earlier['alias_statuses'][index] for index in kept],
                                    *['active'] * len(alias_keys)])
    else:
        tag = new_tag_record(
            actor_id=plan.actor_id, space_id=plan.space_id, namespace=source['namespace_kind'],
            project_id=source.get('namespace_project_id'), name=spec.name, name_key=key,
            description=spec.description, language=source.get('language'), actor_kind='human',
            source_application=None, reason=reason, distinct_from=[source['id']], at=plan.at)
        tag.update(aliases=[alias for alias, _ in moved_aliases], alias_keys=alias_keys,
                   alias_statuses=['active'] * len(alias_keys))
        plan.create(tag)
        new_id = tag['id']
    plan.other_id = new_id
    landings = await reader.links_by_ids([tag_link_id(plan.space_id, new_id, link['item_kind'], link['item_id'])
                                          for link in chosen])
    for link in chosen:
        plan.write_link({**link, 'status': 'moved', 'moved_to_tag_id': new_id, 'detached_at': plan.at,
                         'detached_by_kind': 'human'}, link)
        landing = landings.get(tag_link_id(plan.space_id, new_id, link['item_kind'], link['item_id']))
        plan.write_link(new_link(plan.space_id, new_id, link['item_kind'], link['item_id'], plan.at, 'human',
                                 moved_from_tag_id=source['id']), landing)
    plan.summary.update(new_tag_name=spec.name, revives=revives, links_moved=len(chosen),
                        aliases=[alias for alias, _ in moved_aliases], status_after=source['status'])


def _holders(plan: _Plan, namespaces: list[str], key: str, *, besides: str | None) -> set[str]:
    """Live tags that hold the word in these namespaces, directly or as a merged
    tag's target; `besides` is the merged tag a split brings back."""
    holders = set()
    for tag in plan.tags.values():
        if tag['id'] == besides or tag['namespace_key'] not in namespaces or (
                tag['name_key'] != key and key not in tag['alias_keys']):
            continue
        if tag['status'] in LIVE_STATUSES:
            holders.add(tag['id'])
        elif tag['status'] == 'merged':
            target = _live_target(plan, tag)
            if target is not None:
                holders.add(target)
    return holders


def _live_target(plan: _Plan, tag: dict) -> str | None:
    seen = set()
    while tag['status'] == 'merged' and tag['id'] not in seen and tag.get('merged_into_id') in plan.tags:
        seen.add(tag['id'])
        tag = plan.tags[tag['merged_into_id']]
    return tag['id'] if tag['status'] in LIVE_STATUSES else None


async def _undo(plan: _Plan, reader, request, reason):
    subject = plan.subject_id
    candidates = [revision['operation_id'] for revision in await reader.revisions(subject, 200)
                  if revision.get('operation_id') and revision.get('action') != 'undo']
    operations = await reader.operations(dict.fromkeys(candidates))
    undone = await reader.undone(list(operations))
    if request.operation_id:
        if request.operation_id not in operations:
            raise HTTPException(status_code=404, detail='tag change not found')
        if request.operation_id in undone:
            return 'already_undone'
        operation = operations[request.operation_id]
    else:
        open_operations = [operations[op] for op in dict.fromkeys(candidates) if op in operations and op not in undone]
        if not open_operations:
            return 'nothing_to_undo'
        operation = open_operations[0]
    plan.undoes = operation['operation_id']
    snapshot = json.loads(operation['snapshot_json'])
    plan.summary['undo'] = operation
    changed = []
    for tag_id, entry in snapshot['tags'].items():
        tag = plan.tags.get(tag_id)
        plan.basis[f'tag:{tag_id}'] = tag['version'] if tag else None
        if tag is None or governed_state(tag) != entry['after']:
            changed.append(tag_id)
    stored_links = await reader.links_by_ids(list(snapshot['links']))
    for link_id, entry in snapshot['links'].items():
        stored = stored_links.get(link_id)
        plan.basis[f'link:{link_id}'] = stored.get('version') if stored else None
        if stored is None or _link_snapshot(stored) != entry['after']:
            changed.append(link_id)
    if changed or await _relied_on(plan, reader, snapshot, stored_links):
        return 'changed_since'
    for tag_id, entry in snapshot['tags'].items():
        before = entry['before']
        # A tag the change created goes out of use; its node and history stay.
        plan.update(tag_id, **({'status': 'retired'} if before is None else before))
    for link_id, entry in snapshot['links'].items():
        stored, before = stored_links[link_id], entry['before']
        restored = ({'status': 'detached', 'detached_at': plan.at, 'detached_by_kind': 'human',
                     'moved_from_tag_id': None, 'moved_to_tag_id': None} if before is None
                    else _link_restored(before))
        plan.write_link({**stored, **restored}, stored)
    # A tag the operation touched other than this one is named in its revisions.
    plan.other_id = operation.get('related_tag_id') if operation['tag_id'] == subject else operation['tag_id']
    if plan.other_id not in plan.tags:
        plan.other_id = None


async def _relied_on(plan: _Plan, reader, snapshot: dict, stored_links: dict) -> bool:
    """Whether a link this undo would take away carries another change's tag:
    a later merge or split that found the link already on its target moved its
    own link away and wrote nothing to this one (rec#11 D-23.8). That change is
    undone first; until then its moved link still points here."""
    leaving = [stored_links[link_id] for link_id, entry in snapshot['links'].items()
               if stored_links[link_id]['status'] == 'attached' and (entry['before'] or {}).get('status') != 'attached']
    if not leaving:
        return False
    dependents = await reader.links_moved_into(
        [{'tag_id': link['tag_id'], 'item_kind': link['item_kind'], 'item_id': link['item_id']} for link in leaving])
    outside = [link for link in dependents if link['id'] not in snapshot['links']]
    for link in outside:
        plan.basis[f'link:{link["id"]}'] = link.get('version')
    return bool(outside)


def governed_state(tag: dict) -> dict:
    """The fields a change may set on a tag, a missing list read as empty."""
    return {name: tag.get(name) if name in _SCALAR_FIELDS else list(tag.get(name) or [])
            for name in GOVERNED_FIELDS}


def _link_snapshot(stored: dict) -> dict:
    """A link's fields as the undo record keeps them (times as ISO text)."""
    return {name: stored[name].isoformat() if isinstance(stored.get(name), datetime) else stored.get(name)
            for name in LINK_FIELDS}


def _link_restored(before: dict) -> dict:
    return {name: datetime.fromisoformat(value) if name in _LINK_TIMES and value else value
            for name, value in before.items()}


_PLANNERS = {'approve': _approve, 'retire': _retire, 'remove_alias': _remove_alias, 'relate': relate,
             'unrelate': unrelate, 'merge': _merge, 'split': _split, 'undo': _undo}


def _preview(plan: _Plan, request: KnowledgeTagGovernanceRequest, blocked: str | None
             ) -> KnowledgeTagGovernancePreview:
    summary = plan.summary
    counted = plan.namespaces is None
    other = plan.current(plan.other_id) if plan.other_id and plan.visible(plan.other_id) else None
    dropped = [KnowledgeTagRelationDrop(tag=reference(plan.current(tag_id)), relation=relation,
                                        target=reference(plan.current(target)), reason=why)
               for tag_id, relation, target, why in summary.get('dropped', [])
               if plan.visible(tag_id) and plan.visible(target)]
    undo = summary.get('undo')
    preview = KnowledgeTagGovernancePreview(
        change=request.change, tag=reference(plan.tags[plan.subject_id]),
        other=reference(other) if other else None, status_after=summary.get('status_after'),
        new_tag_name=summary.get('new_tag_name'), revives=summary.get('revives', False),
        links_moved=summary.get('links_moved') if counted else None,
        links_already_on_target=summary.get('links_already_on_target') if counted else None,
        aliases=summary.get('aliases', []), relations_moved=summary.get('relations_moved', 0),
        relations_dropped=dropped,
        undo=KnowledgeTagUndoPreview(
            operation_id=undo['operation_id'], action=undo['action'], created_at=undo['created_at'],
            restores=[reference(plan.tags[tag_id]) for tag_id in json.loads(undo['snapshot_json'])['tags']
                      if tag_id in plan.tags and plan.visible(tag_id)]) if undo else None,
        blocked=KnowledgeTagBlocked(code=blocked, message=_MESSAGES[blocked]) if blocked else None,
        digest='0' * 64)
    fingerprint = json.dumps({'preview': preview.model_dump(mode='json', exclude={'digest'}),
                              'basis': plan.basis, 'request': request.model_dump(
                                  mode='json', include={'change', 'tag_id', 'into_tag_id', 'target_tag_id',
                                                        'relation', 'alias', 'operation_id', 'split',
                                                        'include_all_projects'})},
                             ensure_ascii=False, sort_keys=True, separators=(',', ':'), default=str)
    return preview.model_copy(update={'digest': sha256_text(fingerprint)})
