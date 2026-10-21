"""Where one host session's Agent conversation is kept: the journal scope of an
Agent in a project (or its global journal), the session's binding in it, and
the conversation the binding names. The journal store and the session record
reads derive these the same way."""
from .provider_values import stable_uuid


def conversation_scope_id(space_id, personal_project_id, agent_id):
    """The journal scope of one Agent in one project, or its global journal."""
    if personal_project_id is None:
        return stable_uuid('global-conversation-scope', space_id, agent_id)
    return stable_uuid('conversation-scope', space_id, personal_project_id, agent_id)


def conversation_binding_id(scope, source_application, session_id):
    return stable_uuid(scope, source_application, session_id)


def started_conversation_id(binding_id):
    """The conversation a session's binding names when it is first written."""
    return stable_uuid('conversation', binding_id)


async def bound_conversation_id(store, space_id, personal_project_id, agent_id, source_application, session_id):
    """The conversation one host session writes to under one Agent now: the
    one its binding names (a resume may rebind it), else the one its first
    write will create."""
    binding = conversation_binding_id(conversation_scope_id(space_id, personal_project_id, agent_id),
                                      source_application, session_id)
    rows, _, _ = await store.runtime.driver.execute_query(
        'OPTIONAL MATCH (b:FuliConversationBinding {id: $id}) RETURN b.conversation_id AS conversation_id',
        id=binding, routing_='r')
    bound = rows[0]['conversation_id'] if rows else None
    return bound or started_conversation_id(binding)


async def current_session_conversation_id(store, space_id, source_application, session_id):
    """The conversation a host session's current task writes to, or None when
    the session has no FULI task with an Agent (no journal to point at). A
    knowledge write made during that task names it as its source."""
    if not source_application:
        return None
    rows, _, _ = await store.runtime.driver.execute_query(
        '''
        MATCH (:FuliSpace {id: $space_id, kind: 'personal'})-[:HAS_TASK_CONTEXT_SESSION]->
              (session:FuliTaskContextSession {id: $session_node})-[:HAS_CONTEXT]->(task:FuliTaskContext)
        WHERE task.token = session.current_token
        RETURN task.personal_project_id AS project_id, task.project_agent_id AS agent_id
        ''', space_id=space_id, session_node=store._task_session_id(space_id, source_application, session_id),
        routing_='r')
    if not rows or not rows[0]['agent_id']:
        return None
    return await bound_conversation_id(store, space_id, rows[0]['project_id'], rows[0]['agent_id'],
                                       source_application, session_id)
