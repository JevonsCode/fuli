"""A corrected preference replaces the old one (rec#75).

A preference is known by its preference_key in one scope (global, one
project, or one project Agent). When a person confirms a preference, every
other current preference with the same key in the same scope ends where it
starts and links to it, the way a keyed value of a relation does
(knowledge_versions.end_keyed_values): it keeps its words and stays readable
as history. No model decides it, and nothing is deleted.

A confirmed capture that restates a stored preference under the same capture
key with new words is a new version of it: the capture writes it under a new
ID, so the stored version keeps its words instead of the capture silently
landing on it unchanged.
"""
from .knowledge_versions import invalid_property, lock_knowledge, record_version_revision
from .provider_values import preference_key, stable_uuid

PREFERENCE_REPLACEMENT_REASON = 'A confirmed preference with the same key and scope replaced it.'


_FIELDS = '''
item.uuid AS item_id, item.fuli_key AS key, item.fuli_attributes_json AS attributes_json,
coalesce(item.fuli_preference_scope, 'global') AS preference_scope,
item.fuli_preference_project_id AS preference_project_id,
item.fuli_preference_agent_id AS preference_agent_id,
coalesce(item.fuli_confirmation_status, 'pending') AS confirmation_status
'''
_ENTITIES = ('''
MATCH (item:Entity {group_id: $group_id})
WHERE item.fuli_invalid_at IS NULL AND item.fuli_profile_aspect IS NOT NULL AND $where
RETURN 'entity' AS item_kind, item.name AS name, coalesce(item.summary, '') AS summary,''' + _FIELDS)
_RELATIONSHIPS = ('''
MATCH ()-[item:RELATES_TO {group_id: $group_id}]->()
WHERE item.invalid_at IS NULL AND item.fuli_profile_aspect IS NOT NULL AND $where
RETURN 'relationship' AS item_kind, item.name AS name, item.fact AS summary,''' + _FIELDS)
_SAME_SCOPE = ('''coalesce(item.fuli_preference_scope, 'global') = $scope
  AND coalesce(item.fuli_preference_project_id, '') = coalesce($project_id, '')
  AND coalesce(item.fuli_preference_agent_id, '') = coalesce($agent_id, '')''')


async def _preferences(store, space, query, **parameters) -> list[dict]:
    records, _, _ = await store.runtime.driver.execute_query(
        '// write-time supersession: current preferences\n' + query,
        group_id=space['group_id'], routing_='r', **parameters)
    return [{**dict(record), 'preference_key': preference_key(record['attributes_json'], record['key'],
                                                              record['item_id'])} for record in records]


_SAME_SCOPE_QUERY = ' UNION ALL '.join(query.replace('$where', _SAME_SCOPE) for query in (_ENTITIES, _RELATIONSHIPS))


def _named(item_kind) -> str:
    return (_ENTITIES if item_kind == 'entity' else _RELATIONSHIPS).replace('$where', 'item.uuid IN $item_ids')


async def end_older_preferences(scoped, actor, space, item_kind, item_id, *, changed_by, created_at,
                                scopes: dict | None = None) -> list[dict]:
    """Make the confirmed preference `item_id` the only current one of its key
    and scope, inside the caller's transaction. Returns the items it ended.

    A caller settling many items in one transaction passes one `scopes` dict:
    each scope's current preferences are then read once (11-06: 全部确认 read
    every preference of the scope again for each item) and kept current here
    as items end, so every item sees what a fresh read would show."""
    found = await _preferences(scoped, space, _named(item_kind), item_ids=[item_id])
    if not found or found[0]['confirmation_status'] != 'confirmed':
        return []
    new = found[0]
    await lock_knowledge(scoped, space)
    scope = (new['preference_scope'], new['preference_project_id'], new['preference_agent_id'])
    current = scopes.get(scope) if scopes is not None else None
    if current is None:
        current = await _preferences(scoped, space, _SAME_SCOPE_QUERY, scope=scope[0], project_id=scope[1],
                                     agent_id=scope[2])
        if scopes is not None:
            scopes[scope] = current
    ended = []
    for old in list(current):
        if old['item_id'] != item_id and old['preference_key'] == new['preference_key']:
            old_kind = old['item_kind']
            await _end(scoped, space, old_kind, old['item_id'], item_kind, item_id, created_at)
            await record_version_revision(
                scoped, actor, space, old_kind, old['item_id'],
                revision_id=stable_uuid(space['id'], 'knowledge-revision', 'preference-replacement',
                                        old['item_id'], item_id),
                action='supersede', reason=PREFERENCE_REPLACEMENT_REASON,
                previous={'content': old['summary'] or old['name'], 'invalidAt': None},
                current={'content': old['summary'] or old['name'], 'invalidAt': created_at.isoformat(),
                         'replacedByItemId': item_id, 'replacedByItemKind': item_kind,
                         'preferenceReplacement': {'preferenceKey': new['preference_key']}},
                changed_by=changed_by, created_at=created_at)
            ended.append({'item_kind': old_kind, 'item_id': old['item_id']})
            current.remove(old)
    return ended


def forget_ended(scopes: dict, ended: list[dict]) -> None:
    """Items another rule ended in the same transaction are no longer current."""
    gone = {(item['item_kind'], item['item_id']) for item in ended}
    for current in scopes.values():
        current[:] = [item for item in current if (item['item_kind'], item['item_id']) not in gone]


async def _end(scoped, space, item_kind, item_id, replaced_by_kind, replaced_by_id, created_at) -> None:
    invalid = invalid_property(item_kind)
    match = ('MATCH (item:Entity {uuid: $item_id, group_id: $group_id})' if item_kind == 'entity'
             else 'MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()')
    await scoped.runtime.driver.execute_query(
        match + f'''
        WHERE item.{invalid} IS NULL
        SET item.fuli_ai_review_lock_version = coalesce(item.fuli_ai_review_lock_version, 0) + 1,
            item.{invalid} = $created_at, item.expired_at = coalesce(item.expired_at, $created_at),
            item.fuli_replaced_by_item_id = $replaced_by_id, item.fuli_replaced_by_item_kind = $replaced_by_kind
        ''', item_id=item_id, group_id=space['group_id'], created_at=created_at,
        replaced_by_id=replaced_by_id, replaced_by_kind=replaced_by_kind)


async def restated_preferences(store, space, entities, entity_ids, episode_id) -> dict[str, str]:
    """For each confirmed preference the capture states under a stored
    current preference's ID with other words, the new version's ID; the
    settle step then ends the stored one (end_older_preferences). A replay of
    the same episode finds the same ID."""
    stated = {entity_id: entity for entity, entity_id in zip(entities, entity_ids, strict=True)
              if entity.profile_aspect and entity.confirmation_status == 'confirmed'}
    if not stated:
        return {}
    stored = await _preferences(store, space, _named('entity'), item_ids=list(stated))
    return {record['item_id']: stable_uuid(space['id'], 'knowledge-version', 'entity', record['item_id'], episode_id)
            for record in stored
            if (stated[record['item_id']].name, stated[record['item_id']].summary)
            != (record['name'], record['summary'])}
