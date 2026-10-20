from .config import Settings
from .provider_values import graphiti_group_id, native_datetime
from .runtime import GraphitiRuntime
from .store_identity import StoreIdentity
from .store_agent_conversations import StoreAgentConversations
from .store_conversation_triage import StoreConversationTriage
from .store_agent_loans import StoreAgentLoans
from .store_agent_verification import StoreAgentVerification
from .store_knowledge import StoreKnowledge
from .store_project_agent_executors import StoreProjectAgentExecutors
from .store_project_agent_score_card import StoreProjectAgentScoreCard
from .store_project_agent_memory import StoreProjectAgentMemory
from .store_project_agent_context import StoreProjectAgentContext
from .default_project_lead import StoreDefaultProjectLead
from .store_project_agents import StoreProjectAgents
from .store_project_agent_dismissal import StoreProjectAgentDismissal
from .store_project_agent_occupation import StoreProjectAgentOccupation
from .store_occupation_catalog import StoreOccupationCatalog
from .store_project_agent_pages import StoreProjectAgentPages
from .store_project_agent_attention import StoreProjectAgentAttention
from .store_project_agent_tasks import StoreProjectAgentTasks
from .store_projects import StoreProjects
from .store_publication import StorePublication
from .store_records import StoreRecords
from .store_task_contexts import StoreTaskContexts
from .store_project_agent_worker_runs import StoreProjectAgentWorkerRuns


class GraphStore(
    StoreIdentity,
    StoreAgentConversations,
    StoreConversationTriage,
    StoreAgentLoans,
    StoreAgentVerification,
    StoreProjects,
    StoreProjectAgents,
    StoreProjectAgentDismissal,
    StoreProjectAgentOccupation,
    StoreOccupationCatalog,
    StoreProjectAgentPages,
    StoreProjectAgentAttention,
    StoreProjectAgentMemory,
    StoreProjectAgentContext,
    StoreDefaultProjectLead,
    StoreTaskContexts,
    StoreProjectAgentWorkerRuns,
    StoreProjectAgentExecutors,
    StoreProjectAgentScoreCard,
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
