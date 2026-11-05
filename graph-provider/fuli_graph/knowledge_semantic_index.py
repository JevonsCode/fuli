"""The meaning index (rec#88): which items still need a vector of a model,
storing the vectors Node computed, and how far the index is.

A vector is derived data, an index: storing one writes no history and no
human-change record, and changes no version, lock_version or timestamp. It
lives on the item, so a permanent delete takes it along. Only items default
search could return are indexed: current, of this space, resting on no
unresolved basis, confirmed by a person or an Agent, and reachable through a
scope (a preference, an assignment, a source episode or a project reference).
"""
from .knowledge_item_view import personal_reader_space
from .knowledge_semantic import semantic_hash, semantic_text
from .knowledge_semantic_models import (
    SemanticPendingItem,
    SemanticPendingPage,
    SemanticPendingRequest,
    SemanticStatus,
    SemanticStatusRequest,
    SemanticVectorWrite,
    SemanticVectorWriteResult,
)
from .search_projection import is_default_retrievable
from .store_transactions import query_store_transaction

# Items read per query while looking for pending ones.
SCAN_CHUNK = 500
ITEM_KINDS = ('entity', 'relationship')

_ELIGIBLE = {
    'entity': '''
        MATCH (item:Entity {group_id: $group_id})
        WHERE item.uuid > $after AND item.fuli_invalid_at IS NULL''',
    'relationship': '''
        MATCH ()-[item:RELATES_TO {group_id: $group_id}]->()
        WHERE item.uuid > $after AND item.invalid_at IS NULL''',
}
_REACHABLE = {
    'entity': 'EXISTS { MATCH (:Episodic {group_id: $group_id})-[:MENTIONS]->(item) }',
    'relationship': 'size(coalesce(item.episodes, [])) > 0',
}
_SOURCE_EPISODES = {
    'entity': 'OPTIONAL MATCH (episode:Episodic {group_id: $group_id})-[:MENTIONS]->(item)',
    'relationship': '''OPTIONAL MATCH (episode:Episodic {group_id: $group_id})
        WHERE episode.uuid IN coalesce(item.episodes, [])''',
}


def _scan_query(item_kind: str) -> str:
    text = ('item.name AS name, item.summary AS summary' if item_kind == 'entity'
            else 'item.fact AS fact')
    return _ELIGIBLE[item_kind] + '''
          AND size(coalesce(item.fuli_unresolved_bases, [])) = 0
        OPTIONAL MATCH (assignment:FuliKnowledgeAssignment {
          space_id: $space_id, item_kind: $item_kind, item_id: item.uuid
        })
        WITH item, assignment
        WHERE item.fuli_profile_aspect IS NOT NULL OR assignment IS NOT NULL
           OR ''' + _REACHABLE[item_kind] + '''
           OR EXISTS { MATCH (:FuliSpace {id: $space_id})-[:HAS_KNOWLEDGE_REFERENCE]->
                             (:FuliKnowledgeProjectReference {item_kind: $item_kind, item_id: item.uuid,
                                                              status: 'active'}) }
        ''' + _SOURCE_EPISODES[item_kind] + '''
        WITH item, assignment, min(episode.fuli_personal_project_id) AS episode_project_id
        RETURN item.uuid AS id, ''' + text + ''',
               coalesce(item.fuli_confirmation_status, 'pending') AS confirmation_status,
               item.fuli_confirmation_basis_json AS confirmation_basis_json,
               coalesce(assignment.project_id, item.fuli_preference_project_id, episode_project_id)
                 AS personal_project_id,
               item.fuli_semantic_model AS semantic_model, item.fuli_semantic_hash AS semantic_hash
        ORDER BY item.uuid
        LIMIT $chunk
        '''


async def _eligible(store, space, item_kind: str, after: str):
    """The eligible items of one kind after `after`, one chunk at a time."""
    while True:
        records, _, _ = await store.runtime.driver.execute_query(
            _scan_query(item_kind), group_id=space['group_id'], space_id=space['id'], item_kind=item_kind,
            after=after, chunk=SCAN_CHUNK, routing_='r')
        for record in records:
            if is_default_retrievable(record):
                text = semantic_text(item_kind, record)
                yield record, text, semantic_hash(text)
        if len(records) < SCAN_CHUNK:
            return
        after = records[-1]['id']


def _cursor(after: str | None) -> tuple[int, str]:
    if not after:
        return 0, ''
    kind, _, item_id = after.partition(':')
    return (ITEM_KINDS.index(kind), item_id) if kind in ITEM_KINDS else (len(ITEM_KINDS), '')


async def pending_semantic_items(store, actor, request: SemanticPendingRequest) -> SemanticPendingPage:
    space = await personal_reader_space(store, actor, request.personal_space_id)
    start, after = _cursor(request.after)
    items = []
    for kind_index in range(start, len(ITEM_KINDS)):
        item_kind = ITEM_KINDS[kind_index]
        async for record, text, text_hash in _eligible(store, space, item_kind, after if kind_index == start else ''):
            if record['semantic_model'] == request.model and record['semantic_hash'] == text_hash:
                continue
            if len(items) == request.limit:
                last = items[-1]
                return SemanticPendingPage(items=items, next=f'{last.item_kind}:{last.item_id}')
            items.append(SemanticPendingItem(
                item_kind=item_kind, item_id=record['id'], personal_project_id=record['personal_project_id'],
                text=text, hash=text_hash))
    return SemanticPendingPage(items=items, next=None)


async def semantic_status(store, actor, request: SemanticStatusRequest) -> SemanticStatus:
    space = await personal_reader_space(store, actor, request.personal_space_id)
    total = done = 0
    for item_kind in ITEM_KINDS:
        async for record, _, text_hash in _eligible(store, space, item_kind, ''):
            total += 1
            done += record['semantic_model'] == request.model and record['semantic_hash'] == text_hash
    return SemanticStatus(total=total, done=done)


# The item's write lock, held to the commit, then its text: an edit waits, so
# the text checked is the text the vector is stored beside. The lock property
# is removed in the same statement and the item is left as it was.
_LOCKED_TEXT = {
    'entity': '''
        MATCH (item:Entity {uuid: $item_id, group_id: $group_id})
        SET item._semantic_lock = true REMOVE item._semantic_lock
        RETURN item.name AS name, item.summary AS summary''',
    'relationship': '''
        MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()
        SET item._semantic_lock = true REMOVE item._semantic_lock
        RETURN item.fact AS fact''',
}
_STORE_VECTOR = {
    'entity': '''
        MATCH (item:Entity {uuid: $item_id, group_id: $group_id})
        SET item.fuli_semantic_vector = $vector, item.fuli_semantic_model = $model,
            item.fuli_semantic_hash = $hash''',
    'relationship': '''
        MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()
        SET item.fuli_semantic_vector = $vector, item.fuli_semantic_model = $model,
            item.fuli_semantic_hash = $hash''',
}


async def write_semantic_vectors(store, actor, request: SemanticVectorWrite) -> SemanticVectorWriteResult:
    space = await personal_reader_space(store, actor, request.personal_space_id)
    written, skipped = 0, []
    # One transaction: a vector never lands on text other than its own.
    async with query_store_transaction(store) as scoped:
        for item in request.items:
            parameters = {'item_id': item.item_id, 'group_id': space['group_id']}
            records, _, _ = await scoped.runtime.driver.execute_query(_LOCKED_TEXT[item.item_kind], **parameters)
            if not records or semantic_hash(semantic_text(item.item_kind, records[0])) != item.hash:
                skipped.append(item.item_id)
                continue
            await scoped.runtime.driver.execute_query(
                _STORE_VECTOR[item.item_kind], vector=item.vector, model=request.model, hash=item.hash,
                **parameters)
            written += 1
    return SemanticVectorWriteResult(written=written, skipped=skipped)


def register_knowledge_semantic_routes(application, store, Actor) -> None:
    @application.post('/v1/semantic/pending', response_model=SemanticPendingPage)
    async def semantic_pending(request: SemanticPendingRequest, actor: Actor):
        return await pending_semantic_items(store, actor, request)

    @application.post('/v1/semantic/vectors', response_model=SemanticVectorWriteResult)
    async def semantic_vectors(request: SemanticVectorWrite, actor: Actor):
        return await write_semantic_vectors(store, actor, request)

    @application.post('/v1/semantic/status', response_model=SemanticStatus)
    async def semantic_index_status(request: SemanticStatusRequest, actor: Actor):
        return await semantic_status(store, actor, request)
