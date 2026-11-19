"""Which host session made each session temporary project, proved from records.

A session's temporary project ID is a hash of its space, client and session
(``session_temporary_project_id``; until 2026-10-18 ``conversation_fallback_project_id``).
The client cannot be read back from the hash, and a project record does not
store it. This read collects the (client, session) pairs FULI already recorded
for the space (conversation session bindings, conversation journal events, and
the episodes knowledge was saved from), derives both IDs for each pair, and
names a project's source only when exactly one recorded pair derives its full
ID. A task temporary project, a miss or an ambiguous match has no source. Only
the client and the session ID leave: no conversation text, title or path.
Read on demand by a picker, never on the console's state refresh."""

from .conversation_scope import conversation_scopes_for_space
from .models import StrictModel
from .temporary_project_scope import conversation_fallback_project_id, session_temporary_project_id


class TemporaryProjectSource(StrictModel):
    personal_project_id: str
    # As recorded: a client name the console knows, or one it shows as another client.
    source_application: str
    session_id: str


async def temporary_project_sources(store, actor, personal_space_id: str) -> list[dict]:
    store._require_personal()
    space = await store.authorize(actor, personal_space_id, 'reader')
    temporary_ids = await _temporary_project_ids(store, space['id'])
    if not temporary_ids:
        return []
    derived: dict[str, set[tuple[str, str]]] = {}
    for client, session in await _recorded_sessions(store, space):
        for project_id in (session_temporary_project_id(space['id'], client, session),
                           conversation_fallback_project_id(space['id'], client, session)):
            if project_id in temporary_ids:
                derived.setdefault(project_id, set()).add((client, session))
    return [{'personal_project_id': project_id, 'source_application': pairs[0][0], 'session_id': pairs[0][1]}
            for project_id, pairs in sorted((key, sorted(value)) for key, value in derived.items()) if len(pairs) == 1]


async def _temporary_project_ids(store, space_id) -> set[str]:
    rows, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:CONTAINS_PROJECT]->(project:FuliPersonalProject)
        WHERE project.scope_type = 'temporary' OR project.project_id STARTS WITH 'conversation-'
        RETURN project.project_id AS project_id
        ''', space_id=space_id, routing_='r')
    return {row['project_id'] for row in rows}


async def _recorded_sessions(store, space) -> set[tuple[str, str]]:
    """Every (client, session) FULI recorded in this space; a missing client reads as
    'other', as the code that derived the IDs did."""
    scopes = list(await conversation_scopes_for_space(store, space['id']))
    rows, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (session:FuliConversationSession) WHERE session.scope IN $scopes
        RETURN DISTINCT session.source_application AS client, session.session_id AS session_id
        UNION
        MATCH (conversation:FuliConversation)-[:HAS_EVENT]->(event:FuliConversationEvent)
        WHERE conversation.scope IN $scopes AND event.session_id IS NOT NULL
        RETURN DISTINCT event.source_application AS client, event.session_id AS session_id
        UNION
        MATCH (episode:Episodic {group_id: $group_id}) WHERE episode.fuli_session_id IS NOT NULL
        RETURN DISTINCT episode.fuli_source_application AS client, episode.fuli_session_id AS session_id
        ''', scopes=scopes, group_id=space['group_id'], routing_='r')
    return {(row['client'] or 'other', row['session_id']) for row in rows if row['session_id']}
