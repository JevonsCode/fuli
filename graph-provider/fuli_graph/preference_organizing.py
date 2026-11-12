"""The person's current preferences, read for an AI that tidies them with the
person (rec#121): a page of them, compact, and on the first page the copies
the duplicate pair rules (knowledge_duplicate_rules, through
knowledge_duplicates.duplicate_pairs) call one. Preferences are never merged
automatically (their own conflict review), so here a duplicate is only a
proposal: the AI asks the person and applies a yes with the existing
knowledge tools. Copies are compared within one aspect and one scope, and a
relationship also within one relation type and the same two endpoints, as the
periodic merge compares them; a preference repeated across projects is the
global-candidate check's (personal_global_preferences). Read only, and as an
Agent reads: another FLA's own preferences stay hidden (knowledge_visibility).
"""
from typing import Literal

from fastapi import HTTPException
from pydantic import Field

from .knowledge_audit_models import KnowledgeItemKind
from .knowledge_duplicates import duplicate_item_fields, duplicate_pairs
from .knowledge_semantic import item_text
from .knowledge_visibility import fla_relationship_visible_cypher, fla_visible_cypher, knowledge_reader, \
    reader_parameter
from .model_base import StrictModel

# A preference is one sentence or two; a longer text is cut, its id reads the rest.
TEXT_CHARS = 300
MAX_DUPLICATE_GROUPS = 100

_PLACE = '''item.fuli_profile_aspect AS aspect, coalesce(item.fuli_preference_scope, 'global') AS scope,
       item.fuli_preference_project_id AS project_id, coalesce(item.fuli_preference_project_ids, []) AS project_ids,
       item.fuli_preference_agent_id AS agent_id'''
_SCANS = {
    'entity': f'''
        MATCH (item:Entity {{group_id: $group_id}})
        WHERE item.fuli_invalid_at IS NULL AND item.fuli_profile_aspect IS NOT NULL
          AND {fla_visible_cypher('item', 'entity')}
        OPTIONAL MATCH (episode:Episodic {{group_id: $group_id}})-[:MENTIONS]->(item)
        WITH item, max(episode.created_at) AS said_at
        RETURN item {duplicate_item_fields('item', 'said_at')} AS item, {_PLACE}''',
    # Retired ones too: their endpoints are preference subjects all the same.
    'relationship': f'''
        MATCH (source:Entity {{group_id: $group_id}})-[item:RELATES_TO {{group_id: $group_id}}]->(target:Entity)
        WHERE item.fuli_profile_aspect IS NOT NULL
          AND {fla_relationship_visible_cypher('item', 'source', 'target')}
        RETURN item {duplicate_item_fields('item')} AS item, item.invalid_at IS NULL AS current, item.name AS relation,
               source.uuid AS source_id, target.uuid AS target_id, {_PLACE}''',
}


class PreferenceOrganizingRead(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)


class OrganizingPreference(StrictModel):
    item_kind: KnowledgeItemKind
    item_id: str
    aspect: str
    scope: str
    project_id: str | None = None
    status: str
    text: str


class DuplicateCopy(StrictModel):
    item_id: str
    rule: Literal['same_text', 'covers', 'same_meaning']


class PreferenceDuplicateGroup(StrictModel):
    item_kind: KnowledgeItemKind
    keep: str
    same: list[DuplicateCopy]


class PreferenceOrganizingPage(StrictModel):
    """Empty fields are left out of the answer: no next_offset on the last
    page, no duplicates after the first."""
    total: int
    pending: int
    preferences: list[OrganizingPreference]
    next_offset: int | None = None
    duplicates: list[PreferenceDuplicateGroup] | None = None
    duplicates_truncated: bool | None = None


async def read_preference_organizing(store, actor, request: PreferenceOrganizingRead) -> PreferenceOrganizingPage:
    store._require_personal()
    space = await store.authorize(actor, request.personal_space_id, 'reader')
    if space['kind'] != 'personal':
        raise HTTPException(status_code=422, detail='preference organising is personal-only')
    reader = await knowledge_reader(store, actor, space, personal_project_id=None, project_agent_id=None)
    scanned = {}
    for item_kind, scan in _SCANS.items():
        records, _, _ = await store.runtime.driver.execute_query(
            '// preference organising: scan\n' + scan, group_id=space['group_id'],
            reader=reader_parameter(reader), routing_='r')
        scanned[item_kind] = [dict(record) for record in records]
    # As the console lists them: an entity a preference relationship this reader
    # sees hangs on (current or retired) is that preference's subject, not one of its own.
    subjects = {record[end] for record in scanned['relationship'] for end in ('source_id', 'target_id')}
    current = {'entity': [record for record in scanned['entity'] if record['item']['item_id'] not in subjects],
               'relationship': [record for record in scanned['relationship'] if record['current']]}
    preferences = sorted((_preference(item_kind, record) for item_kind, records in current.items() for record in records),
                         key=lambda item: (item.scope != 'global', item.project_id or '', item.aspect, item.text))
    end = request.offset + request.limit
    page = PreferenceOrganizingPage(
        total=len(preferences), pending=sum(item.status == 'pending' for item in preferences),
        preferences=preferences[request.offset:end], next_offset=end if end < len(preferences) else None)
    if request.offset:
        return page
    groups = []
    for item_kind, records in current.items():
        pairs = await duplicate_pairs(store, space, item_kind, [_comparable(item_kind, record) for record in records])
        groups += _duplicate_groups(item_kind, pairs)
    page.duplicates = groups[:MAX_DUPLICATE_GROUPS]
    page.duplicates_truncated = len(groups) > MAX_DUPLICATE_GROUPS
    return page


def _duplicate_groups(item_kind: str, pairs) -> list[PreferenceDuplicateGroup]:
    """The pairs as groups around the copy that stays: a copy kept in one pair
    and dropped in a later one joins the group of the copy that finally stays."""
    kept_by = {merge.drop['item_id']: (merge.keep['item_id'], merge.rule) for merge in pairs}

    def stays(item_id):
        while item_id in kept_by:
            item_id = kept_by[item_id][0]
        return item_id

    groups = {}
    for drop_id, (_, rule) in kept_by.items():
        groups.setdefault(stays(drop_id), []).append(DuplicateCopy(item_id=drop_id, rule=rule))
    return [PreferenceDuplicateGroup(item_kind=item_kind, keep=keep, same=same) for keep, same in groups.items()]


def _comparable(item_kind: str, record: dict) -> dict:
    """Two preferences are compared only within one aspect and one scope; two
    relationships also only with one relation type between the same two
    entities, as the periodic merge compares them."""
    place = [record['scope'], record['project_id'] or '', ','.join(sorted(record['project_ids'])), record['agent_id'] or '']
    if item_kind == 'relationship':
        return {'item': record['item'], 'kind_key': (record['aspect'], record['relation']),
                'places': [[*place, record['source_id'], record['target_id']]]}
    return {'item': record['item'], 'kind_key': record['aspect'], 'places': [place]}


def _preference(item_kind: str, record: dict) -> OrganizingPreference:
    item = record['item']
    text = item_text(item_kind, item)
    return OrganizingPreference(
        item_kind=item_kind, item_id=item['item_id'], aspect=record['aspect'], scope=record['scope'],
        project_id=record['project_id'], status=item['confirmation_status'],
        text=text if len(text) <= TEXT_CHARS else text[:TEXT_CHARS - 1] + '…')


def register_preference_organizing_routes(application, store, Actor) -> None:
    @application.post('/v1/knowledge/preferences/organizing', response_model=PreferenceOrganizingPage,
                      response_model_exclude_none=True)
    async def preference_organizing(request: PreferenceOrganizingRead, actor: Actor):
        return await read_preference_organizing(store, actor, request)
