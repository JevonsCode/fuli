"""The meaning index (rec#88): which items still need a vector of a model,
storing the vectors Node computed, and how far the index is.

A vector is derived data, an index: storing one writes no history and no
human-change record, and changes no version, lock_version or timestamp. It
lives on the item, so a permanent delete takes it along. Only the items
knowledge_index_scan covers are indexed. The text embedded includes the
item's retrieval terms (rec#92), so storing terms leaves the item pending
until it is embedded again.
"""
from .knowledge_index_scan import indexable_from, indexable_items, locked_item, ITEM_KINDS
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
from .store_transactions import query_store_transaction


def _indexed(item_kind: str, record, model: str) -> tuple[bool, str, str]:
    text = semantic_text(item_kind, record)
    text_hash = semantic_hash(text)
    return record['semantic_model'] == model and record['semantic_hash'] == text_hash, text, text_hash


async def pending_semantic_items(store, actor, request: SemanticPendingRequest) -> SemanticPendingPage:
    space = await personal_reader_space(store, actor, request.personal_space_id)
    items = []
    async for item_kind, record in indexable_from(store, space, request.after):
        indexed, text, text_hash = _indexed(item_kind, record, request.model)
        if indexed:
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
        async for record in indexable_items(store, space, item_kind):
            total += 1
            done += _indexed(item_kind, record, request.model)[0]
    return SemanticStatus(total=total, done=done)


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
            record = await locked_item(scoped, space, item.item_kind, item.item_id)
            if record is None or semantic_hash(semantic_text(item.item_kind, record)) != item.hash:
                skipped.append(item.item_id)
                continue
            await scoped.runtime.driver.execute_query(
                _STORE_VECTOR[item.item_kind], vector=item.vector, model=request.model, hash=item.hash,
                item_id=item.item_id, group_id=space['group_id'])
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
