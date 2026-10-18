"""Private-space occupation catalog, CAS writes, and atomic assignment guards."""

from uuid import uuid4
from fastapi import HTTPException
from .occupation_catalog import (
    BUILTIN_OCCUPATIONS, BUILTIN_OCCUPATION_KEYS, TEXT_FIELDS,
    OccupationEntry, OccupationRevision, OccupationUpdate,
)
from .provider_values import native_datetime, now_utc, stable_uuid
from .store_transactions import query_store_transaction

OCCUPATION_LOCK = '''
    SET space._occupation_catalog_lock = true
    REMOVE space._occupation_catalog_lock
'''


def active_occupation_predicate(keys='$occupation_keys'):
    # Keys expressions are internal Cypher only; user values are always parameters.
    return f'''all(occupation_key IN {keys} WHERE
      EXISTS {{ MATCH (space)-[:HAS_OCCUPATION]->(occupation:FuliOccupation)
        WHERE occupation.key = occupation_key AND occupation.status = 'active' }}
      OR (occupation_key IN $builtin_occupation_keys AND NOT EXISTS {{
        MATCH (space)-[:HAS_OCCUPATION]->(occupation:FuliOccupation)
        WHERE occupation.key = occupation_key }}))'''


def occupation_error(status, code, message):
    raise HTTPException(status, {'code': code, 'message': message})


async def require_active_occupations(store, space_id, keys):
    rows, _, _ = await store.runtime.driver.execute_query(
        '''MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
        RETURN ''' + active_occupation_predicate() + ' AS valid',
        space_id=space_id, occupation_keys=keys,
        builtin_occupation_keys=BUILTIN_OCCUPATION_KEYS,
    )
    if not rows or not rows[0]['valid']:
        occupation_error(422, 'occupation_inactive', 'Every occupation role and tag must be active in this personal space.')


class StoreOccupationCatalog:
    async def _ensure_occupation_catalog(self, space_id):
        now = now_utc()
        defaults = [{**entry, 'id': stable_uuid(self.settings.provider_id, space_id, 'occupation', entry['key'])}
                    for entry in BUILTIN_OCCUPATIONS]
        await self.runtime.driver.execute_query(
            '''MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
            ''' + OCCUPATION_LOCK + '''
            WITH space UNWIND $defaults AS item
            MERGE (occupation:FuliOccupation {id: item.id})
            ON CREATE SET occupation += item, occupation.builtin = true,
              occupation.status = 'active', occupation.created_at = $now,
              occupation.updated_at = $now, occupation.revision = 0
            MERGE (space)-[:HAS_OCCUPATION]->(occupation)
            ''', space_id=space_id, defaults=defaults, now=now,
        )

    async def _occupation_entries(self, space_id, key=None, *, include_archived=False):
        rows, _, _ = await self.runtime.driver.execute_query(
            '''MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})-
              [:HAS_OCCUPATION]->(occupation:FuliOccupation)
            WHERE $key IS NULL OR occupation.key = $key
            OPTIONAL MATCH (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(agent:FuliProjectAgent)
            WHERE $include_archived OR coalesce(agent.status, 'active') <> 'archived'
            WITH occupation, agent,
              CASE WHEN agent.agent_id = 'employee.assistant' THEN 'assistant'
                WHEN agent.agent_id IN ['employee.bole', 'employee.jefa', 'employee.tonborg'] THEN 'management'
                ELSE agent.occupation_role END AS role,
              CASE WHEN agent.agent_id IN ['employee.bole', 'employee.jefa', 'employee.tonborg', 'employee.assistant']
                THEN [] ELSE coalesce(agent.occupation_tags, []) END AS tags
            RETURN occupation, count(DISTINCT CASE WHEN role = occupation.key OR occupation.key IN tags THEN agent END) AS agent_count
            ORDER BY occupation.builtin DESC, occupation.created_at, occupation.key
            ''', space_id=space_id, key=key, include_archived=include_archived,
        )
        return [OccupationEntry(**{
            **{field: dict(row['occupation'])[field] for field in ('key', *TEXT_FIELDS, 'builtin', 'status', 'revision')},
            'created_at': native_datetime(row['occupation']['created_at']),
            'updated_at': native_datetime(row['occupation']['updated_at']),
            'agent_count': row['agent_count'],
        }) for row in rows]

    async def list_occupations(self, actor, space_id):
        self._require_personal()
        await self.authorize(actor, space_id, 'reader')
        # Initialize catalog metadata only; existing Agent occupations are untouched.
        await self._ensure_occupation_catalog(space_id)
        return await self._occupation_entries(space_id)

    async def create_occupation(self, actor, request):
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        async with query_store_transaction(self) as scoped:
            await scoped._ensure_occupation_catalog(request.personal_space_id)
            key = f'custom_{uuid4().hex}'
            now = now_utc()
            await scoped.runtime.driver.execute_query(
                '''MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
                CREATE (occupation:FuliOccupation)
                SET occupation = $properties
                CREATE (space)-[:HAS_OCCUPATION]->(occupation)''',
                space_id=request.personal_space_id,
                properties={**request.model_dump(include=set(TEXT_FIELDS)),
                    'id': stable_uuid(scoped.settings.provider_id, request.personal_space_id, 'occupation', key),
                    'key': key, 'builtin': False, 'status': 'active', 'revision': 0,
                    'created_at': now, 'updated_at': now},
            )
            return (await scoped._occupation_entries(request.personal_space_id, key))[0]

    async def update_occupation(self, actor, key, request, *, delete=False):
        self._require_personal()
        await self.authorize(actor, request.personal_space_id, 'maintainer')
        async with query_store_transaction(self) as scoped:
            await scoped._ensure_occupation_catalog(request.personal_space_id)
            entries = await scoped._occupation_entries(request.personal_space_id, key, include_archived=delete)
            if not entries:
                occupation_error(404, 'occupation_not_found', 'Occupation not found in this personal space.')
            current = entries[0]
            if current.revision != request.revision:
                occupation_error(409, 'occupation_revision_conflict', 'Occupation changed; reload and retry.')
            if delete:
                if current.builtin:
                    occupation_error(409, 'occupation_builtin', 'Built-in occupations can be hidden, not deleted.')
                if current.agent_count:
                    occupation_error(409, 'occupation_in_use', 'An Agent uses this occupation; archive it instead.')
                await scoped.runtime.driver.execute_query(
                    '''MATCH (:FuliSpace {id: $space_id})-[:HAS_OCCUPATION]->(occupation:FuliOccupation {key: $key})
                    DETACH DELETE occupation''', space_id=request.personal_space_id, key=key)
                return current
            changes = request.model_dump(exclude_unset=True, exclude={'personal_space_id', 'revision'})
            await scoped.runtime.driver.execute_query(
                '''MATCH (:FuliSpace {id: $space_id})-[:HAS_OCCUPATION]->(occupation:FuliOccupation {key: $key})
                SET occupation += $changes, occupation.revision = occupation.revision + 1,
                    occupation.updated_at = $now''',
                space_id=request.personal_space_id, key=key, changes=changes, now=now_utc(),
            )
            return (await scoped._occupation_entries(request.personal_space_id, key))[0]

    async def archive_occupation(self, actor, key, request: OccupationRevision):
        return await self.update_occupation(actor, key, OccupationUpdate(
            **request.model_dump(), status='archived'))
