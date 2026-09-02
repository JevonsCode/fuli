from .config import Settings
from .provider_values import graphiti_group_id, native_datetime
from .runtime import GraphitiRuntime
from .store_identity import StoreIdentity
from .store_knowledge import StoreKnowledge
from .store_project_agent_executors import StoreProjectAgentExecutors
from .store_project_agent_memory import StoreProjectAgentMemory
from .store_project_agent_context import StoreProjectAgentContext
from .store_project_agents import StoreProjectAgents
from .store_project_agent_tasks import StoreProjectAgentTasks
from .store_projects import StoreProjects
from .store_publication import StorePublication
from .store_records import StoreRecords
from .store_task_contexts import StoreTaskContexts


class GraphStore(
    StoreIdentity,
    StoreProjects,
    StoreProjectAgents,
    StoreProjectAgentMemory,
    StoreProjectAgentContext,
    StoreTaskContexts,
    StoreProjectAgentExecutors,
    StoreProjectAgentTasks,
    StorePublication,
    StoreKnowledge,
    StoreRecords,
):
    def __init__(self, runtime: GraphitiRuntime, settings: Settings):
        self.runtime = runtime
        self.settings = settings
        self._group_locks = {}


__all__ = ['GraphStore', 'graphiti_group_id', 'native_datetime']
