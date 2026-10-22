"""Neo4j port of the open tag vocabulary.

(space)-[:HAS_KNOWLEDGE_TAG]->(tag)-[:HAS_TAG_REVISION]->(revision) keeps every
vocabulary change; (tag)-[:TAGS]->(link) names one knowledge item by kind and
ID, because a tag may label a relationship as well as an entity. Every write
takes the space's knowledge lock first inside one transaction (the lock new
versions of items take too), and the domain decides under that lock: two
Agents creating one concept, a merge and an attach, or a split and an alias are
judged one after the other (G4-4, G4-5). Nothing is deleted: a merged, retired,
moved or detached record keeps its node. Tag and link IDs are deterministic and
unique-constrained as well.
"""
from contextlib import asynccontextmanager

from .knowledge_management import _read_assignment, _read_item, _source_project_ids
from .knowledge_project_scope import knowledge_project_ids
from .knowledge_tag_models import LIVE_STATUSES
from .knowledge_versions import lock_knowledge
from .provider_values import native_datetime
from .store_transactions import query_store_transaction

VISIBLE_STATUSES = list(LIVE_STATUSES)
_DATETIME_FIELDS = ('created_at', 'updated_at')
_LINK_DATETIME_FIELDS = ('attached_at', 'detached_at')
_REVISION_DATETIME_FIELDS = ('created_at',)


class StoreKnowledgeTags:
    def knowledge_tag_vocabulary(self):
        return Neo4jKnowledgeTagVocabulary(self)


class Neo4jKnowledgeTagVocabulary:
    def __init__(self, store):
        self._store = store

    def reader(self, space_id):
        return Neo4jTagReader(self._store.runtime.driver, space_id)

    @asynccontextmanager
    async def locked(self, space_id):
        """Reads inside see every earlier decision; the next writer waits for this one."""
        async with query_store_transaction(self._store) as scoped:
            await lock_knowledge(scoped, {'id': space_id})
            yield Neo4jLockedTagVocabulary(scoped.runtime.driver, space_id)

    async def item_scope(self, space, item_kind, item_id):
        """None when the item is missing here, else (kind, project_ids):
        ('global', []) only for explicitly global profile knowledge;
        ('projects', ids) for a project-scoped, assigned or project-sourced item,
        several ids when several projects' episodes mention it or active
        references add projects to other knowledge;
        ('unknown', []) when no source is known."""
        current = await _read_item(self._store, space, item_id, item_kind)
        if current is None:
            return None
        if current.get('preference_scope') not in (None, 'global') and current.get('preference_project_id'):
            return 'projects', list(current.get('preference_project_ids') or [current['preference_project_id']])
        if not current.get('profile_aspect'):
            projects = await knowledge_project_ids(self._store, space, item_id, item_kind)
            return ('projects', projects) if projects else ('unknown', [])
        assignment = await _read_assignment(self._store, space['id'], item_id, item_kind)
        if assignment:
            return 'projects', [assignment.project_id]
        if current.get('preference_scope') == 'global':
            return 'global', []
        sources = await _source_project_ids(self._store, space, item_id, item_kind)
        return ('projects', sources) if sources else ('unknown', [])

    async def item_titles(self, space, refs):
        """A short title per linked item: an entity's name, a relationship's fact."""
        driver = self._store.runtime.driver
        ids = {kind: [ref['item_id'] for ref in refs if ref['item_kind'] == kind]
               for kind in ('entity', 'relationship')}
        titles = {}
        if ids['entity']:
            records, _, _ = await driver.execute_query(
                'UNWIND $ids AS id MATCH (item:Entity {uuid: id, group_id: $group_id}) '
                'RETURN id, item.name AS title', ids=ids['entity'], group_id=space['group_id'], routing_='r')
            titles.update({('entity', record['id']): record['title'] for record in records})
        if ids['relationship']:
            records, _, _ = await driver.execute_query(
                'UNWIND $ids AS id MATCH ()-[item:RELATES_TO {uuid: id, group_id: $group_id}]->() '
                'RETURN id, item.fact AS title', ids=ids['relationship'], group_id=space['group_id'],
                routing_='r')
            titles.update({('relationship', record['id']): record['title'] for record in records})
        return titles

    async def metrics(self, space_id, namespace_keys, since):
        scope = ('MATCH (tag:FuliKnowledgeTag {space_id: $space_id}) '
                 'WHERE ($namespaces IS NULL OR tag.namespace_key IN $namespaces) '
                 'AND tag.status IN $statuses ')
        parameters = {'space_id': space_id, 'namespaces': namespace_keys,
                      'statuses': VISIBLE_STATUSES, 'routing_': 'r'}
        driver = self._store.runtime.driver
        counts, _, _ = await driver.execute_query(
            scope + 'RETURN tag.namespace_kind AS namespace, tag.status AS status, count(*) AS count '
            'ORDER BY namespace, status', **parameters)
        created, _, _ = await driver.execute_query(
            scope + 'AND tag.created_at >= $since '
            'RETURN toString(date(tag.created_at)) AS date, count(*) AS created, '
            "sum(CASE WHEN tag.initial_status = 'provisional' THEN 1 ELSE 0 END) AS provisional "
            'ORDER BY date', since=since, **parameters)
        return [dict(record) for record in counts], [dict(record) for record in created]


class Neo4jTagReader:
    """One personal space's vocabulary; resolve and the locked writes share it."""

    def __init__(self, driver, space_id):
        self._driver, self._space_id = driver, space_id

    async def find_by_key(self, namespace_keys, key):
        """Live tags whose name or alias is the word."""
        return await self._by_key(namespace_keys, key, VISIBLE_STATUSES)

    async def find_redirects(self, namespace_keys, key):
        """Merged tags whose name or alias is the word; they lead to where they went."""
        return await self._by_key(namespace_keys, key, ['merged'])

    async def _by_key(self, namespace_keys, key, statuses):
        records, _, _ = await self._driver.execute_query(
            'MATCH (tag:FuliKnowledgeTag {space_id: $space_id}) '
            'WHERE tag.namespace_key IN $namespaces AND tag.status IN $statuses '
            'AND (tag.name_key = $key OR $key IN tag.alias_keys) '
            'RETURN tag ORDER BY tag.name_key = $key DESC, tag.created_at',
            space_id=self._space_id, namespaces=namespace_keys, statuses=statuses,
            key=key, routing_='r')
        return [_tag(record['tag']) for record in records]

    async def list_visible(self, namespace_keys, limit):
        records, _, _ = await self._driver.execute_query(
            'MATCH (tag:FuliKnowledgeTag {space_id: $space_id}) '
            'WHERE tag.namespace_key IN $namespaces AND tag.status IN $statuses '
            'RETURN tag ORDER BY tag.name_key LIMIT $limit',
            space_id=self._space_id, namespaces=namespace_keys, statuses=VISIBLE_STATUSES,
            limit=limit, routing_='r')
        return [_tag(record['tag']) for record in records]

    async def get_any(self, tag_id):
        """The tag in any status: a merged one still names where it went."""
        if not tag_id:
            return None
        records, _, _ = await self._driver.execute_query(
            'MATCH (tag:FuliKnowledgeTag {id: $tag_id, space_id: $space_id}) RETURN tag',
            tag_id=tag_id, space_id=self._space_id, routing_='r')
        return _tag(records[0]['tag']) if records else None

    async def by_identity(self, namespace_key, name_key):
        """The tag holding a word as its name in one namespace, in any status."""
        records, _, _ = await self._driver.execute_query(
            'MATCH (tag:FuliKnowledgeTag {space_id: $space_id, namespace_key: $namespace_key, '
            'name_key: $name_key}) RETURN tag',
            space_id=self._space_id, namespace_key=namespace_key, name_key=name_key, routing_='r')
        return _tag(records[0]['tag']) if records else None

    async def all_tags(self):
        """The space's whole vocabulary in every status: governance decides relations,
        cycles and redirects over it, and the console filters it."""
        records, _, _ = await self._driver.execute_query(
            'MATCH (tag:FuliKnowledgeTag {space_id: $space_id}) RETURN tag ORDER BY tag.id',
            space_id=self._space_id, routing_='r')
        return [_tag(record['tag']) for record in records]

    async def links_by_ids(self, link_ids):
        if not link_ids:
            return {}
        records, _, _ = await self._driver.execute_query(
            'MATCH (link:FuliKnowledgeTagLink {space_id: $space_id}) WHERE link.id IN $ids RETURN link',
            space_id=self._space_id, ids=list(link_ids), routing_='r')
        return {link['id']: link for link in (_link(record['link']) for record in records)}

    async def links_of(self, tag_ids, limit=None):
        """Attached links of the tags, oldest first."""
        records, _, _ = await self._driver.execute_query(
            '''
            MATCH (tag:FuliKnowledgeTag {space_id: $space_id})-[:TAGS]->
                  (link:FuliKnowledgeTagLink {status: 'attached'})
            WHERE tag.id IN $tag_ids
            RETURN link ORDER BY link.attached_at, link.id
            ''' + ('LIMIT $limit' if limit else ''),
            space_id=self._space_id, tag_ids=list(tag_ids), limit=limit, routing_='r')
        return [_link(record['link']) for record in records]

    async def link_counts(self, tag_ids):
        records, _, _ = await self._driver.execute_query(
            '''
            MATCH (tag:FuliKnowledgeTag {space_id: $space_id})-[:TAGS]->
                  (link:FuliKnowledgeTagLink {status: 'attached'})
            WHERE tag.id IN $tag_ids
            RETURN tag.id AS tag_id, count(link) AS count
            ''', space_id=self._space_id, tag_ids=list(tag_ids), routing_='r')
        return {record['tag_id']: record['count'] for record in records}

    async def attached_count(self, item_kind, item_id):
        records, _, _ = await self._driver.execute_query(
            '''
            MATCH (link:FuliKnowledgeTagLink {space_id: $space_id, item_kind: $item_kind,
                                              item_id: $item_id, status: 'attached'})
            RETURN count(link) AS attached
            ''', space_id=self._space_id, item_kind=item_kind, item_id=item_id, routing_='r')
        return records[0]['attached']

    async def item_tags(self, item_kind, item_id, namespace_keys):
        records, _, _ = await self._driver.execute_query(
            '''
            MATCH (tag:FuliKnowledgeTag {space_id: $space_id})-[:TAGS]->
                  (:FuliKnowledgeTagLink {item_kind: $item_kind, item_id: $item_id, status: 'attached'})
            WHERE tag.namespace_key IN $namespaces AND tag.status IN $statuses
            RETURN tag ORDER BY tag.name_key
            ''', space_id=self._space_id, item_kind=item_kind, item_id=item_id,
            namespaces=namespace_keys, statuses=VISIBLE_STATUSES, routing_='r')
        return [_tag(record['tag']) for record in records]

    async def revisions(self, tag_id, limit):
        """A tag's history, newest first."""
        records, _, _ = await self._driver.execute_query(
            '''
            MATCH (:FuliKnowledgeTag {id: $tag_id, space_id: $space_id})-[:HAS_TAG_REVISION]->(revision)
            RETURN revision ORDER BY revision.created_at DESC, revision.version DESC LIMIT $limit
            ''', tag_id=tag_id, space_id=self._space_id, limit=limit, routing_='r')
        return [_revision(record['revision']) for record in records]

    async def operations(self, operation_ids):
        """Each operation's undo record: the revision that keeps its before-state."""
        if not operation_ids:
            return {}
        records, _, _ = await self._driver.execute_query(
            '''
            UNWIND $ids AS id
            MATCH (revision:FuliKnowledgeTagRevision {space_id: $space_id, operation_id: id})
            WHERE revision.snapshot_json IS NOT NULL
            RETURN revision
            ''', space_id=self._space_id, ids=list(operation_ids), routing_='r')
        return {revision['operation_id']: revision
                for revision in (_revision(record['revision']) for record in records)}

    async def undone(self, operation_ids):
        """The operations an undo already reversed."""
        if not operation_ids:
            return set()
        records, _, _ = await self._driver.execute_query(
            '''
            UNWIND $ids AS id
            MATCH (revision:FuliKnowledgeTagRevision {space_id: $space_id, undoes_operation_id: id})
            RETURN DISTINCT id
            ''', space_id=self._space_id, ids=list(operation_ids), routing_='r')
        return {record['id'] for record in records}


class Neo4jLockedTagVocabulary(Neo4jTagReader):
    """Writes the domain decided under the space lock this transaction holds."""

    async def apply(self, *, new_tags=(), updates=(), links=(), revisions=()):
        """One change: new tags, field updates (each a new tag version), link
        records and the revisions that explain them, stamped with the version
        their tag reached. Returns the written tags by ID."""
        written = {}
        if new_tags:
            records, _, _ = await self._driver.execute_query(
                '''
                MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
                UNWIND $tags AS row
                CREATE (space)-[:HAS_KNOWLEDGE_TAG]->(tag:FuliKnowledgeTag)
                SET tag = row
                RETURN tag
                ''', space_id=self._space_id, tags=list(new_tags))
            written.update({tag['id']: tag for tag in (_tag(record['tag']) for record in records)})
        if updates:
            records, _, _ = await self._driver.execute_query(
                '''
                UNWIND $updates AS row
                MATCH (tag:FuliKnowledgeTag {id: row.id, space_id: $space_id})
                SET tag += row.fields, tag.version = tag.version + 1, tag.updated_at = row.at
                RETURN tag
                ''', space_id=self._space_id, updates=list(updates))
            written.update({tag['id']: tag for tag in (_tag(record['tag']) for record in records)})
        if links:
            await self._driver.execute_query(
                '''
                UNWIND $links AS row
                MATCH (tag:FuliKnowledgeTag {id: row.tag_id, space_id: $space_id})
                MERGE (link:FuliKnowledgeTagLink {id: row.id})
                ON CREATE SET link.version = 0, link.space_id = $space_id, link.tag_id = row.tag_id,
                              link.item_kind = row.item_kind, link.item_id = row.item_id
                SET link.status = row.status, link.attached_at = row.attached_at,
                    link.attached_by_kind = row.attached_by_kind, link.detached_at = row.detached_at,
                    link.detached_by_kind = row.detached_by_kind, link.moved_to_tag_id = row.moved_to_tag_id,
                    link.moved_from_tag_id = row.moved_from_tag_id, link.version = link.version + 1
                MERGE (tag)-[:TAGS]->(link)
                ''', space_id=self._space_id, links=list(links))
        if revisions:
            await self._driver.execute_query(
                '''
                UNWIND $revisions AS row
                MATCH (tag:FuliKnowledgeTag {id: row.tag_id, space_id: $space_id})
                CREATE (tag)-[:HAS_TAG_REVISION]->(revision:FuliKnowledgeTagRevision)
                SET revision = row, revision.version = tag.version
                ''', space_id=self._space_id, revisions=list(revisions))
        return written


def _tag(node) -> dict:
    return _native(node, _DATETIME_FIELDS)


def _link(node) -> dict:
    return _native(node, _LINK_DATETIME_FIELDS)


def _revision(node) -> dict:
    return _native(node, _REVISION_DATETIME_FIELDS)


def _native(node, fields) -> dict:
    record = dict(node)
    for field in fields:
        record[field] = native_datetime(record.get(field))
    return record
