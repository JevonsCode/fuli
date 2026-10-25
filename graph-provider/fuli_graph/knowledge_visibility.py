"""Who may read FLA-scoped knowledge.

Knowledge an FLA's own episodes wrote, and a preference the person gave one
FLA, belong to that FLA in its project, and to the person. Search, the graph
read, item views, turn receipts, session records, the human-change search,
the AI review and its decisions, preference conflicts, a session's
migration preview and the key-only visible-items read (which local judgment
records ask, rec#50) all decide it here.

The person's console proves itself with the human-review channel and reads
everything. Any other reader is an Agent: one FLA in one project, or a plain
session that is no FLA. No proof means an Agent reader, never a full read; a
wrong proof is refused before any read (app.current_review_aware_actor), and
a reader naming an FLA that is not assigned to that project is refused here.
"""
from dataclasses import dataclass

from .project_agent_access import authorize_project_agent


@dataclass(frozen=True)
class AgentReader:
    personal_project_id: str | None = None
    project_agent_id: str | None = None


PLAIN_SESSION = AgentReader()


async def knowledge_reader(store, actor: dict, space: dict, *, personal_project_id: str | None,
                           project_agent_id: str | None) -> AgentReader | None:
    """None for the person's console (full read), else the Agent reading."""
    if actor.get('_human_review_verified') is True:
        return None
    if not project_agent_id:
        return PLAIN_SESSION
    agent = await authorize_project_agent(store, actor, space, personal_project_id, project_agent_id)
    return AgentReader(personal_project_id, agent['agent_id'])


async def request_reader(store, actor: dict, space: dict, request) -> AgentReader | None:
    """knowledge_reader for a request with reader_project_id and reader_agent_id."""
    return await knowledge_reader(store, actor, space, personal_project_id=request.reader_project_id,
                                  project_agent_id=request.reader_agent_id)


def fla_visible(record: dict, reader: AgentReader) -> bool:
    """Whether this reader may see the item. record carries profile_aspect,
    preference_scope, preference_project_id, preference_agent_id and, from
    the item's own episodes, episode_project_ids and episode_project_agent_ids.
    A preference follows its own scope only; other knowledge any FLA's
    episode wrote belongs to that FLA in that project. A relationship's
    record also carries endpoints_visible (fla_endpoints_visible_cypher): one
    linking to an entity this reader may not see is hidden with it."""
    if record.get('endpoints_visible') is False:
        return False
    if record.get('profile_aspect'):
        if (record.get('preference_scope') or 'global') != 'agent':
            return True
        return (
            bool(reader.project_agent_id)
            and record.get('preference_agent_id') == reader.project_agent_id
            and record.get('preference_project_id') == reader.personal_project_id
        )
    agent_ids = record.get('episode_project_agent_ids') or []
    if not agent_ids:
        return True
    return (
        bool(reader.project_agent_id)
        and reader.project_agent_id in agent_ids
        and reader.personal_project_id in (record.get('episode_project_ids') or [])
    )


def fla_visible_cypher(item: str, item_kind: str) -> str:
    """fla_visible as a Cypher predicate on the bound `item` (an Entity, or a
    RELATES_TO edge), so a page is cut after hiding and shows no gap. Needs
    $group_id and $reader (reader_parameter: null for the person)."""
    def episodes(condition: str) -> str:
        if item_kind == 'entity':
            return (f'EXISTS {{ MATCH (fla_episode:Episodic {{group_id: $group_id}})-[:MENTIONS]->({item}) '
                    f'WHERE {condition} }}')
        return (f'EXISTS {{ MATCH (fla_episode:Episodic {{group_id: $group_id}}) '
                f'WHERE fla_episode.uuid IN coalesce({item}.episodes, []) AND {condition} }}')

    return f'''($reader IS NULL OR coalesce(
          CASE WHEN {item}.fuli_profile_aspect IS NOT NULL
            THEN coalesce({item}.fuli_preference_scope, 'global') <> 'agent'
              OR ({item}.fuli_preference_agent_id = $reader.project_agent_id
                  AND {item}.fuli_preference_project_id = $reader.personal_project_id)
            ELSE NOT {episodes('fla_episode.fuli_project_agent_id IS NOT NULL')}
              OR ({episodes('fla_episode.fuli_project_agent_id = $reader.project_agent_id')}
                  AND {episodes('fla_episode.fuli_personal_project_id = $reader.personal_project_id')})
          END, false))'''


def fla_relationship_visible_cypher(edge: str, source: str, target: str) -> str:
    """A relationship is visible only with both its endpoints: one that links
    to another FLA's entity is hidden with it, wherever it is read (graph,
    item view, receipt, session records; search and the AI review through
    fla_endpoints_visible_cypher and fla_visible)."""
    return f"({fla_visible_cypher(edge, 'relationship')} AND {fla_endpoints_visible_cypher(source, target)})"


def fla_endpoints_visible_cypher(source: str, target: str) -> str:
    """Whether this reader may see both endpoints of a relationship. Needs
    $group_id and $reader."""
    return f"({fla_visible_cypher(source, 'entity')} AND {fla_visible_cypher(target, 'entity')})"


def fla_own_work_cypher(agent: str, project: str) -> str:
    """Work done under an FLA (a session's turn, or an episode it wrote) is
    that FLA's conversation: an FLA reads its own in its project, a plain
    session only work under no FLA, and only the person all of it. agent and
    project are the Cypher expressions of that work's FLA and project. Needs
    $reader."""
    return f'''($reader IS NULL OR CASE WHEN $reader.project_agent_id IS NULL
            THEN {agent} IS NULL
            ELSE coalesce({agent} = $reader.project_agent_id
                          AND {project} = $reader.personal_project_id, false) END)'''


def fla_visible_ids_cypher(item_ids: str) -> str:
    """True when no entity or relationship among item_ids (a Cypher list
    expression) is hidden from $reader: a record naming another FLA's item
    is left out with it. Needs $group_id and $reader."""
    return (f'''($reader IS NULL OR (
          NOT EXISTS {{ MATCH (fla_item:Entity {{group_id: $group_id}}) WHERE fla_item.uuid IN {item_ids}
                        AND NOT {fla_visible_cypher('fla_item', 'entity')} }}
          AND NOT EXISTS {{ MATCH (fla_source:Entity)-[fla_item:RELATES_TO {{group_id: $group_id}}]->(fla_target:Entity)
                            WHERE fla_item.uuid IN {item_ids}
                            AND NOT {fla_relationship_visible_cypher('fla_item', 'fla_source', 'fla_target')} }}))''')


def fla_episode_visible_cypher(episode: str) -> str:
    """An episode an FLA wrote, as evidence or as a session's source: only
    that FLA in its project reads it. Needs $reader."""
    return f'''($reader IS NULL OR {episode}.fuli_project_agent_id IS NULL
          OR coalesce({episode}.fuli_project_agent_id = $reader.project_agent_id
                      AND {episode}.fuli_personal_project_id = $reader.personal_project_id, false))'''


def reader_parameter(reader: AgentReader | None) -> dict | None:
    if reader is None:
        return None
    return {'personal_project_id': reader.personal_project_id, 'project_agent_id': reader.project_agent_id}


_HIDDEN_QUERIES = {
    'entity': '''
        MATCH (item:Entity {group_id: $group_id}) WHERE item.uuid IN $item_ids
          AND NOT ''' + fla_visible_cypher('item', 'entity') + '''
        RETURN item.uuid AS id''',
    'relationship': '''
        MATCH (source)-[item:RELATES_TO {group_id: $group_id}]->(target)
        WHERE item.uuid IN $item_ids
          AND NOT ''' + fla_relationship_visible_cypher('item', 'source', 'target') + '''
        RETURN item.uuid AS id''',
}
# The same lookups the other way round: the ids that exist and pass the rule.
_VISIBLE_QUERIES = {item_kind: query.replace('AND NOT ', 'AND ', 1) for item_kind, query in _HIDDEN_QUERIES.items()}


async def _matching_refs(store, space: dict, reader: AgentReader | None, queries: dict,
                         refs) -> set[tuple[str, str]]:
    refs = list(refs)
    found = set()
    for item_kind, query in queries.items():
        ids = list(dict.fromkeys(item_id for kind, item_id in refs if kind == item_kind))
        if not ids:
            continue
        records, _, _ = await store.runtime.driver.execute_query(
            query, group_id=space['group_id'], item_ids=ids, reader=reader_parameter(reader), routing_='r')
        found |= {(item_kind, record['id']) for record in records}
    return found


async def hidden_refs(store, space: dict, reader: AgentReader | None, refs) -> set[tuple[str, str]]:
    """The (item_kind, item_id) pairs among these that this reader may not see."""
    if reader is None:
        return set()
    return await _matching_refs(store, space, reader, _HIDDEN_QUERIES, refs)


async def visible_refs(store, space: dict, reader: AgentReader | None, refs) -> set[tuple[str, str]]:
    """The (item_kind, item_id) pairs among these that exist and this reader may
    see (the person, None: every one that exists). A deleted or unknown id is
    not among them, so a caller that needs a yes treats it as hidden."""
    return await _matching_refs(store, space, reader, _VISIBLE_QUERIES, refs)


async def visible_episode_ids(store, space: dict, reader: AgentReader | None, episode_ids) -> list[str]:
    """These episodes in order, without the ones another FLA wrote."""
    episode_ids = list(episode_ids)
    if reader is None or not episode_ids:
        return episode_ids
    records, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (episode:Episodic {group_id: $group_id}) WHERE episode.uuid IN $episode_ids
          AND NOT ''' + fla_episode_visible_cypher('episode') + '''
        RETURN episode.uuid AS id
        ''', group_id=space['group_id'], episode_ids=episode_ids, reader=reader_parameter(reader), routing_='r')
    hidden = {record['id'] for record in records}
    return [episode_id for episode_id in episode_ids if episode_id not in hidden]
