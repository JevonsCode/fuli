"""Neo4j port of the open tag vocabulary.

(space)-[:HAS_KNOWLEDGE_TAG]->(tag)-[:HAS_TAG_REVISION]->(revision) keeps every
vocabulary change; (tag)-[:TAGS]->(link) names one knowledge item by kind and
ID, because a tag may label a relationship as well as an entity. Every write
takes the personal space's lock first inside one transaction; a creation or an
alias is decided by the domain under that same lock, so two Agents creating one
concept or two near-duplicates are judged one after the other (G4-4). Tag and
link IDs are deterministic and unique-constrained as well.
"""
from contextlib import asynccontextmanager

from .knowledge_management import _read_assignment, _read_item, _source_project_ids
from .provider_values import native_datetime
from .store_transactions import query_store_transaction

# Merged and retired tags arrive with governance; they must never resolve.
VISIBLE_STATUSES = ['provisional', 'active']
_DATETIME_FIELDS = ('created_at', 'updated_at')


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
        async with self._locked(space_id) as driver:
            yield Neo4jLockedTagVocabulary(driver, space_id)

    async def item_scope(self, space, item_kind, item_id):
        """None when the item is missing here, else (kind, project_ids):
        ('global', []) only for explicitly global profile knowledge;
        ('projects', ids) for a project-scoped, assigned or project-sourced item,
        several ids when several projects' episodes mention it;
        ('unknown', []) when no source is known."""
        current = await _read_item(self._store, space, item_id, item_kind)
        if current is None:
            return None
        if current.get('preference_scope') not in (None, 'global') and current.get('preference_project_id'):
            return 'projects', [current['preference_project_id']]
        assignment = await _read_assignment(self._store, space['id'], item_id, item_kind)
        if assignment:
            return 'projects', [assignment.project_id]
        if current.get('profile_aspect') and current.get('preference_scope') == 'global':
            return 'global', []
        sources = await _source_project_ids(self._store, space, item_id, item_kind)
        return ('projects', sources) if sources else ('unknown', [])

    async def attach(self, space_id, link, limit):
        async with self._locked(space_id) as driver:
            records, _, _ = await driver.execute_query(
                '''
                OPTIONAL MATCH (current:FuliKnowledgeTagLink {id: $link_id})
                OPTIONAL MATCH (other:FuliKnowledgeTagLink {space_id: $space_id,
                  item_kind: $item_kind, item_id: $item_id, status: 'attached'})
                RETURN current.status AS status, count(other) AS attached
                ''', link_id=link['id'], space_id=space_id, item_kind=link['item_kind'],
                item_id=link['item_id'])
            if records[0]['status'] == 'attached':
                return 'unchanged'
            if records[0]['attached'] >= limit:
                return 'limit'
            await driver.execute_query(
                '''
                MATCH (tag:FuliKnowledgeTag {id: $link.tag_id, space_id: $space_id})
                MERGE (link:FuliKnowledgeTagLink {id: $link.id})
                ON CREATE SET link.version = 0
                SET link += $link, link.version = link.version + 1
                MERGE (tag)-[:TAGS]->(link)
                ''', space_id=space_id, link=link)
            return 'attached'

    async def detach(self, space_id, link_id, detached_at, actor_kind):
        async with self._locked(space_id) as driver:
            records, _, _ = await driver.execute_query(
                '''
                MATCH (link:FuliKnowledgeTagLink {id: $link_id, space_id: $space_id, status: 'attached'})
                SET link.status = 'detached', link.detached_at = $detached_at,
                    link.detached_by_kind = $actor_kind, link.version = link.version + 1
                RETURN count(link) AS changed
                ''', link_id=link_id, space_id=space_id, detached_at=detached_at,
                actor_kind=actor_kind)
            return 'detached' if records and records[0]['changed'] else 'unchanged'

    async def item_tags(self, space_id, item_kind, item_id, namespace_keys):
        records, _, _ = await self._store.runtime.driver.execute_query(
            '''
            MATCH (tag:FuliKnowledgeTag {space_id: $space_id})-[:TAGS]->
                  (:FuliKnowledgeTagLink {item_kind: $item_kind, item_id: $item_id, status: 'attached'})
            WHERE tag.namespace_key IN $namespaces AND tag.status IN $statuses
            RETURN tag ORDER BY tag.name_key
            ''', space_id=space_id, item_kind=item_kind, item_id=item_id,
            namespaces=namespace_keys, statuses=VISIBLE_STATUSES, routing_='r')
        return [_tag(record['tag']) for record in records]

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

    @asynccontextmanager
    async def _locked(self, space_id):
        async with query_store_transaction(self._store) as scoped:
            await scoped.runtime.driver.execute_query(
                "MATCH (space:FuliSpace {id: $space_id, kind: 'personal'}) "
                'SET space._tag_lock = true REMOVE space._tag_lock', space_id=space_id)
            yield scoped.runtime.driver


class Neo4jTagReader:
    """One personal space's visible vocabulary; resolve and the locked writes share it."""

    def __init__(self, driver, space_id):
        self._driver, self._space_id = driver, space_id

    async def find_by_key(self, namespace_keys, key):
        records, _, _ = await self._driver.execute_query(
            'MATCH (tag:FuliKnowledgeTag {space_id: $space_id}) '
            'WHERE tag.namespace_key IN $namespaces AND tag.status IN $statuses '
            'AND (tag.name_key = $key OR $key IN tag.alias_keys) '
            'RETURN tag ORDER BY tag.name_key = $key DESC, tag.created_at',
            space_id=self._space_id, namespaces=namespace_keys, statuses=VISIBLE_STATUSES,
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

    async def get(self, tag_id):
        records, _, _ = await self._driver.execute_query(
            'MATCH (tag:FuliKnowledgeTag {id: $tag_id, space_id: $space_id}) '
            'WHERE tag.status IN $statuses RETURN tag',
            tag_id=tag_id, space_id=self._space_id, statuses=VISIBLE_STATUSES, routing_='r')
        return _tag(records[0]['tag']) if records else None


class Neo4jLockedTagVocabulary(Neo4jTagReader):
    """Writes the domain decided under the space lock this transaction holds."""

    async def insert(self, tag, revision):
        records, _, _ = await self._driver.execute_query(
            '''
            MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
            CREATE (space)-[:HAS_KNOWLEDGE_TAG]->(tag:FuliKnowledgeTag)
            SET tag = $tag
            CREATE (tag)-[:HAS_TAG_REVISION]->(revision:FuliKnowledgeTagRevision)
            SET revision = $revision, revision.version = 1
            RETURN tag
            ''', space_id=self._space_id, tag=tag, revision=revision)
        return _tag(records[0]['tag'])

    async def save_aliases(self, tag_id, fields, revision):
        records, _, _ = await self._driver.execute_query(
            '''
            MATCH (tag:FuliKnowledgeTag {id: $tag_id, space_id: $space_id})
            SET tag += $fields, tag.version = tag.version + 1, tag.updated_at = $revision.created_at
            CREATE (tag)-[:HAS_TAG_REVISION]->(revision:FuliKnowledgeTagRevision)
            SET revision = $revision, revision.version = tag.version
            RETURN tag
            ''', space_id=self._space_id, tag_id=tag_id, fields=fields, revision=revision)
        return _tag(records[0]['tag'])


def _tag(node) -> dict:
    tag = dict(node)
    for field in _DATETIME_FIELDS:
        tag[field] = native_datetime(tag.get(field))
    return tag
