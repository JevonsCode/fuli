"""Retrieval terms (rec#92): the other ways someone would ask for an item,
stored beside it so word search and the meaning index find it by them.

Knowledge saved before FULI asked for search terms has only its own words.
Node asks a model for the missing terms of each item and stores them here.
They are derived data, like a meaning vector: storing them writes no history
and no human-change record, changes no version, lock_version or timestamp,
and nothing waits for a person. Each set keeps the hash of the item's words it
was made from, so an edit leaves the item without current terms again.
"""
from .knowledge_index_scan import ITEM_KINDS, indexable_from, indexable_items, locked_item
from .knowledge_item_view import personal_reader_space
from .knowledge_retrieval_models import (
    RetrievalCandidate,
    RetrievalCandidatesPage,
    RetrievalCandidatesRequest,
    RetrievalStats,
    RetrievalStatsRequest,
    RetrievalTermsWrite,
    RetrievalTermsWriteResult,
)
from .knowledge_semantic import item_text, semantic_hash
from .store_transactions import query_store_transaction


def _current(item_kind: str, record) -> tuple[str, str, bool]:
    """The item's own words, their hash, and whether its stored terms were made from them."""
    text = item_text(item_kind, record)
    text_hash = semantic_hash(text)
    return text, text_hash, bool(record.get('retrieval_terms')) and record.get('retrieval_hash') == text_hash


def _in_project(record, personal_project_id: str | None) -> bool:
    return personal_project_id is None or record['personal_project_id'] == personal_project_id


async def retrieval_candidates(store, actor, request: RetrievalCandidatesRequest) -> RetrievalCandidatesPage:
    space = await personal_reader_space(store, actor, request.personal_space_id)
    items = []
    async for item_kind, record in indexable_from(store, space, request.after):
        if not _in_project(record, request.personal_project_id):
            continue
        text, text_hash, has_terms = _current(item_kind, record)
        if not text or (request.missing_only and has_terms):
            continue
        if len(items) == request.limit:
            last = items[-1]
            return RetrievalCandidatesPage(items=items, next=f'{last.item_kind}:{last.item_id}')
        items.append(RetrievalCandidate(
            item_kind=item_kind, item_id=record['id'], personal_project_id=record['personal_project_id'],
            title=(record.get('name') if item_kind == 'entity' else None) or text[:120], text=text,
            has_terms=has_terms,
            hash=text_hash))
    return RetrievalCandidatesPage(items=items, next=None)


async def retrieval_stats(store, actor, request: RetrievalStatsRequest) -> RetrievalStats:
    space = await personal_reader_space(store, actor, request.personal_space_id)
    counts = {'items': 0, 'with_terms': 0, 'chars': 0, 'missing_chars': 0}
    for item_kind in ITEM_KINDS:
        async for record in indexable_items(store, space, item_kind):
            if not _in_project(record, request.personal_project_id):
                continue
            text, _, has_terms = _current(item_kind, record)
            if not text:
                continue
            counts['items'] += 1
            counts['chars'] += len(text)
            if has_terms:
                counts['with_terms'] += 1
            else:
                counts['missing_chars'] += len(text)
    return RetrievalStats(**counts)


_STORE_TERMS = {
    'entity': '''
        MATCH (item:Entity {uuid: $item_id, group_id: $group_id})
        SET item.fuli_retrieval_terms = $terms, item.fuli_retrieval_context = $context,
            item.fuli_retrieval_hash = $hash''',
    'relationship': '''
        MATCH ()-[item:RELATES_TO {uuid: $item_id, group_id: $group_id}]->()
        SET item.fuli_retrieval_terms = $terms, item.fuli_retrieval_context = $context,
            item.fuli_retrieval_hash = $hash''',
}


async def write_retrieval_terms(store, actor, request: RetrievalTermsWrite) -> RetrievalTermsWriteResult:
    space = await personal_reader_space(store, actor, request.personal_space_id)
    written, skipped = 0, []
    # One transaction: terms never land beside words other than those they were made from.
    async with query_store_transaction(store) as scoped:
        for item in request.items:
            record = await locked_item(scoped, space, item.item_kind, item.item_id)
            if record is None or semantic_hash(item_text(item.item_kind, record)) != item.hash:
                skipped.append(item.item_id)
                continue
            await scoped.runtime.driver.execute_query(
                _STORE_TERMS[item.item_kind], terms=item.terms, context=item.context, hash=item.hash,
                item_id=item.item_id, group_id=space['group_id'])
            written += 1
    return RetrievalTermsWriteResult(written=written, skipped=skipped)


def register_knowledge_retrieval_routes(application, store, Actor) -> None:
    @application.post('/v1/retrieval/candidates', response_model=RetrievalCandidatesPage)
    async def candidates(request: RetrievalCandidatesRequest, actor: Actor):
        return await retrieval_candidates(store, actor, request)

    @application.post('/v1/retrieval/terms', response_model=RetrievalTermsWriteResult)
    async def terms(request: RetrievalTermsWrite, actor: Actor):
        return await write_retrieval_terms(store, actor, request)

    @application.post('/v1/retrieval/stats', response_model=RetrievalStats)
    async def stats(request: RetrievalStatsRequest, actor: Actor):
        return await retrieval_stats(store, actor, request)
