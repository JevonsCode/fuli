"""Which scope of a personal space each node and relationship of the graph
belongs to (docs/runner-roles-design.md, "Scopes in the graph").

A personal space holds two kinds of scope: `global` (the person's habits,
profile, FLA roster and their global memory) and `project:<id>`. No single key
of the graph separates them: almost every label hangs under the space and
belongs to a project by a property, a parent or the knowledge item it is about.
This module is the one place that says which: NODE_RULES and RELATIONSHIP_RULES
are data, one row per label and relationship type the provider writes, and the
judges below read them. tests/test_scope_classifier.py fails when a label or
type the Cypher names has no row.

A node's rule has three parts. `key`: the properties that identify it on any
computer (its export ID). `found`: how a reader finds it in one personal space.
`judge`: which scopes it belongs to. Records that belong to this computer only
(sessions, executors, tokens, the format ledger) are LOCAL_ONLY; records that
are recomputed from others are DERIVED; neither is found or exported. Nothing
here reads or writes the graph: scope_export.py reads, this module decides.
"""
from collections import defaultdict
from dataclasses import dataclass, field

from .conversation_scope import conversation_scope_id

GLOBAL = 'global'
LOCAL_ONLY = 'local_only'
DERIVED = 'derived'
PROJECT_PREFIX = 'project:'
SPACE_LABEL = 'FuliSpace'


def project_scope(project_id: str) -> str:
    return f'{PROJECT_PREFIX}{project_id}'


@dataclass(frozen=True)
class NodeRule:
    key: tuple[str, ...]
    # ('group',): group_id is the space's; ('space', prop): prop is the space's ID;
    # ('child', REL, ParentLabel): (parent)-[:REL]->(node) for a found parent;
    # ('conversation', prop): prop is one of the space's conversation scope IDs;
    # None: never found, because never exported (LOCAL_ONLY, DERIVED).
    found: tuple | None
    # ('fixed', scope); ('projects', props): each non-empty value (text or list)
    # is a project, none is GLOBAL; ('parent',): the scopes of the node it was
    # found under; ('item', kind_prop, id_prop, fallback_props): the scopes of
    # the knowledge item it is about, else the fallback projects, else GLOBAL;
    # ('items', ((kind_prop, id_prop), ...), fallback_props): both items, the
    # project end winning (a cross-scope record); ('knowledge',), ('evidence',),
    # ('project',), ('conversation', prop), ('relation', prop), ('space',).
    judge: tuple
    evidence: str


def _local(evidence: str, key: tuple[str, ...] = ('id',)) -> NodeRule:
    return NodeRule(key, None, ('fixed', LOCAL_ONLY), evidence)


GLOBAL_JUDGE = ('fixed', GLOBAL)
PARENT = ('parent',)

# CLASSIFICATION DATA
NODE_RULES = {
    # The space itself: both scopes need it; an export carries only its ID and group_id.
    'FuliSpace': NodeRule(('id',), None, ('space',), 'store_identity.py'),
    # Knowledge and preferences (graphiti's own labels).
    'Entity': NodeRule(('uuid',), ('group',), ('knowledge',),
                       'collaboration_context.py, knowledge_management.py, knowledge_project_scope.py'),
    'Episodic': NodeRule(('uuid',), ('group',), ('evidence',), 'store_knowledge.py'),
    'FuliPersonalProject': NodeRule(('id',), ('child', 'CONTAINS_PROJECT', 'FuliSpace'), ('project',),
                                    'store_projects.py, temporary_project_scope.py'),
    'FuliPersonalProjectRelationReview': NodeRule(
        ('id',), ('child', 'HAS_PERSONAL_PROJECT_RELATION_REVIEW', 'FuliSpace'), ('relation', 'relation_id'),
        'personal_project_hierarchy.py'),
    'FuliKnowledgeAssignment': NodeRule(('id',), ('space', 'space_id'),
                                        ('item', 'item_kind', 'item_id', ('project_id',)), 'knowledge_management.py'),
    'FuliKnowledgeProjectReference': NodeRule(('id',), ('space', 'space_id'),
                                              ('item', 'item_kind', 'item_id', ('project_id',)),
                                              'project_knowledge.py, knowledge_project_scope.py'),
    'FuliKnowledgeRevision': NodeRule(('id',), ('space', 'space_id'), ('item', 'item_kind', 'item_id', ()),
                                      'knowledge_versions.py, store_knowledge.py'),
    'FuliKnowledgeAudit': NodeRule(('id',), ('space', 'space_id'), ('item', 'item_kind', 'item_id', ()),
                                   'knowledge_audit.py, knowledge_hard_delete_operations.py'),
    'FuliKnowledgeConflict': NodeRule(('id',), ('space', 'space_id'),
                                      ('projects', ('source_project_id', 'target_project_id')), 'project_knowledge.py'),
    'FuliKnowledgeReviewRun': NodeRule(('id',), ('space', 'personal_space_id'),
                                       ('projects', ('personal_project_id',)), 'knowledge_review.py'),
    'FuliKnowledgeReviewDecision': NodeRule(('id',), ('child', 'HAS_REVIEW_DECISION', 'FuliKnowledgeReviewRun'),
                                            PARENT, 'knowledge_review.py'),
    'FuliKnowledgeTag': NodeRule(('id',), ('space', 'space_id'), ('projects', ('namespace_project_id',)),
                                 'store_knowledge_tags.py'),
    'FuliKnowledgeTagRevision': NodeRule(('id',), ('child', 'HAS_TAG_REVISION', 'FuliKnowledgeTag'), PARENT,
                                         'store_knowledge_tags.py'),
    'FuliKnowledgeTagLink': NodeRule(('id',), ('space', 'space_id'), ('item', 'item_kind', 'item_id', ()),
                                     'store_knowledge_tags.py'),
    'FuliPreferenceConflict': NodeRule(
        ('id',), ('space', 'personal_space_id'),
        ('items', (('left_item_kind', 'left_item_id'), ('right_item_kind', 'right_item_id')),
         ('preference_project_id',)), 'preference_conflicts.py'),
    'FuliCommonKnowledgePromotion': NodeRule(('id',), ('space', 'space_id'),
                                             ('projects', ('parent_project_id', 'source_project_ids')),
                                             'knowledge_hard_delete.py (retired 2026-11-11, still readable)'),
    'FuliPersonalGlobalPreferenceDecision': NodeRule(('space_id', 'candidate_id'), ('space', 'space_id'),
                                                     ('projects', ('target_project_id',)),
                                                     'personal_global_preferences.py'),
    'FuliPersonalGlobalPreferenceDecisionEvent': NodeRule(('id',), ('space', 'space_id'),
                                                          ('projects', ('target_project_id',)),
                                                          'personal_global_preferences.py'),
    'FuliWorkflowCandidate': NodeRule(('id',), ('child', 'HAS_WORKFLOW_CANDIDATE', 'FuliSpace'),
                                      ('projects', ('personal_project_id',)), 'workflow_candidates.py'),
    'FuliWorkflowAuthorization': NodeRule(('id',), ('child', 'HAS_WORKFLOW_AUTHORIZATION', 'FuliWorkflowCandidate'),
                                          PARENT, 'workflow_candidates.py'),
    # FLAs: the roster is global; what they do in a project is that project's.
    'FuliProjectAgent': NodeRule(('id',), ('child', 'HAS_PROJECT_AGENT_IDENTITY', 'FuliSpace'), GLOBAL_JUDGE,
                                 'store_project_agents.py'),
    'FuliProjectAgentAlias': NodeRule(('id',), ('child', 'HAS_PROJECT_AGENT_IDENTITY', 'FuliSpace'), GLOBAL_JUDGE,
                                      'system_hr_identity.py'),
    'FuliOccupation': NodeRule(('id',), ('child', 'HAS_OCCUPATION', 'FuliSpace'), GLOBAL_JUDGE,
                               'store_occupation_catalog.py'),
    'FuliProjectAgentDismissal': NodeRule(('id',), ('space', 'personal_space_id'), GLOBAL_JUDGE,
                                          'store_project_agent_dismissal.py'),
    'FuliProjectAgentRecruitmentPolicy': NodeRule(('personal_space_id',), ('space', 'personal_space_id'),
                                                  GLOBAL_JUDGE, 'runtime.py'),
    'FuliProjectAgentAssignment': NodeRule(
        ('id',), ('child', 'HAS_PROJECT_AGENT_ASSIGNMENT', 'FuliPersonalProject'), PARENT,
        'store_project_agents.py, project_agent_access.py'),
    'FuliProjectAgentCoordinationPolicy': NodeRule(
        ('policy_id',), ('child', 'HAS_PROJECT_AGENT_COORDINATION_POLICY', 'FuliPersonalProject'), PARENT,
        'store_project_agent_coordination_policy.py, project_agent_team_growth.py'),
    'FuliProjectAgentMemory': NodeRule(('id',), ('space', 'personal_space_id'),
                                       ('projects', ('personal_project_id',)), 'store_project_agent_memory.py'),
    'FuliProjectAgentMemoryCheckpoint': NodeRule(
        ('id',), ('child', 'HAS_MEMORY_CHECKPOINT', 'FuliProjectAgentMemory'), PARENT,
        'store_project_agent_memory.py'),
    'FuliProjectAgentRecruitment': NodeRule(('id',), ('space', 'personal_space_id'),
                                            ('projects', ('personal_project_id',)),
                                            'store_project_agent_task_recruitment.py'),
    'FuliProjectAgentTask': NodeRule(('id',), ('child', 'HAS_PROJECT_AGENT_TASK', 'FuliSpace'),
                                     ('projects', ('personal_project_id',)), 'store_project_agent_tasks.py'),
    'FuliProjectAgentTaskEvent': NodeRule(('id',), ('child', 'HAS_TASK_EVENT', 'FuliProjectAgentTask'), PARENT,
                                          'store_project_agent_tasks.py, store_project_agent_task_activity.py'),
    'FuliProjectAgentRoutingDecision': NodeRule(('id',), ('child', 'ROUTED_BY', 'FuliProjectAgentTask'), PARENT,
                                                'store_project_agent_tasks.py'),
    'FuliAgentVerification': NodeRule(('id',), ('child', 'HAS_VERIFICATION', 'FuliProjectAgentTask'), PARENT,
                                      'store_agent_verification.py'),
    'FuliProjectAgentWorkerRun': NodeRule(('id',), ('space', 'personal_space_id'),
                                          ('projects', ('personal_project_id',)), 'store_project_agent_worker_runs.py'),
    'FuliAgentAttention': NodeRule(('id',), ('space', 'personal_space_id'), ('projects', ('personal_project_id',)),
                                   'store_project_agent_attention.py'),
    'FuliAgentLoan': NodeRule(('id',), ('space', 'space'), ('projects', ('source_project', 'target_project')),
                              'store_agent_loans.py'),
    'FuliTaskContext': NodeRule(('id',), ('space', 'personal_space_id'), ('projects', ('personal_project_id',)),
                                'store_task_contexts.py'),
    # Conversations are kept per journal scope: a hash of (space, project, Agent).
    'FuliConversation': NodeRule(('id',), ('conversation', 'scope'), ('conversation', 'scope'),
                                 'store_agent_conversations.py, conversation_scope.py'),
    'FuliConversationEvent': NodeRule(('id',), ('child', 'HAS_EVENT', 'FuliConversation'), PARENT,
                                      'store_agent_conversations.py'),
    'FuliConversationSession': NodeRule(('id',), ('conversation', 'scope'), ('conversation', 'scope'),
                                        'store_agent_conversations.py'),
    'FuliConversationPolicy': NodeRule(('id',), ('conversation', 'id'), ('conversation', 'id'),
                                       'store_agent_conversations.py'),
    'FuliConversationTriage': NodeRule(('id',), ('space', 'space_id'),
                                       ('projects', ('personal_project_id', 'formed_project_id')),
                                       'store_conversation_triage.py'),
    'FuliConversationTopicDecline': NodeRule(('space_id', 'topic_key'), ('space', 'space_id'), GLOBAL_JUDGE,
                                             'store_conversation_triage.py'),
    'FuliSubscription': NodeRule(('id',), ('child', 'SUBSCRIBES_TO', 'FuliSpace'), GLOBAL_JUDGE,
                                 'store_publication.py'),
    'FuliPublicationDraft': NodeRule(('id',), ('child', 'HAS_PUBLICATION_DRAFT', 'FuliSpace'), GLOBAL_JUDGE,
                                     'store_publication.py'),
    # This computer's own: who may call it, its sessions, executors, tokens and format ledger.
    'FuliPrincipal': _local('store_identity.py (access tokens of this Provider)'),
    'FuliTaskContextSession': _local('store_task_contexts.py (a client session on this computer)'),
    'FuliConversationBinding': _local('store_agent_conversations.py (a host session\'s read position)'),
    'FuliTranscriptCursor': _local('store_transcript_recovery.py (a transcript file on this computer)'),
    'FuliAgentDelegation': _local('project_agent_delegations.py (a one-use token)', ('token_hash',)),
    'FuliRemoteOriginKey': _local('project_agent_remote_origins.py (this computer\'s signing key)', ('space_id',)),
    'FuliRemoteAgentOrigin': _local('project_agent_remote_origins.py (an expiring proof)',
                                    ('space_id', 'message_id')),
    'FuliRemoteDelegationAttempt': _local('project_agent_delegations.py (a one-use attempt)',
                                          ('space_id', 'origin_node', 'origin_message_id', 'origin_attempt_id')),
    'FuliProjectAgentExecutor': _local('store_project_agent_executors.py (programs on this computer)'),
    'FuliProjectAgentExecutorRoutingRule': _local('store_project_agent_executors.py'),
    'FuliProjectAgentExecutorDecision': _local('store_project_agent_executor_routing.py'),
    'FuliProjectAgentExecutorObservation': _local('store_project_agent_executors.py'),
    'FuliProjectAgentExecutorOutcomeEvidence': _local('store_project_agent_executor_learning.py'),
    'FuliProjectAgentExecutorOutcomeReset': _local('store_project_agent_executor_learning.py'),
    'FuliProjectAgentExecutorOutcomeAggregate': NodeRule(
        ('id',), None, ('fixed', DERIVED), 'store_project_agent_executor_learning.py (recomputed from evidence)'),
    'FuliDataFormat': _local('graph_format_ledger.py', ('store',)),
    'FuliDataFormatEvent': _local('graph_format_ledger.py', ('store', 'seq')),
    'FuliDataFormatUndo': _local('graph_format_journal.py', ('apply_id', 'kind', 'ref')),
    'FuliLeadOccupationMigration': _local('migrate_lead_occupation.py (an undo journal)', ('migration_id',)),
    'FuliLeadOccupationChange': _local('migrate_lead_occupation.py (an undo journal)', ('agent_id',)),
    # Shared (kind 'project') spaces and retired records: not part of a personal space's scopes.
    'FuliProposal': _local('retired_graph_labels.py (shared spaces, retired)'),
    'FuliProjectRelease': _local('graph_format_backfills.py (shared spaces)'),
    'FuliPersonalGlobalPreferenceDecisionPreview': _local('retired_graph_labels.py (retired one-use token)'),
    'FuliWorkflowReviewPreview': _local('retired_graph_labels.py (retired one-use token)'),
    'FuliWorkflowReviewEvent': _local('retired_graph_labels.py (retired)'),
    'FuliWorkflowRule': _local('retired_graph_labels.py (retired)'),
}

# A relationship is judged by its two ends unless it is itself a knowledge
# item (RELATES_TO) or ties a principal to a space. 'endpoints': in every scope
# both ends share, and in the project scopes of an end the other does not share
# (a cross-scope relationship belongs to its non-global end; the other end is
# an external reference). An end that is never exported drops the relationship.
_ENDPOINTS = 'endpoints'
RELATIONSHIP_RULES = {
    'RELATES_TO': ('item', 'store_knowledge.py (a fact or preference item)'),
    'MENTIONS': (_ENDPOINTS, 'store_knowledge.py'),
    'OWNS': (LOCAL_ONLY, 'store_identity.py'),
    'MEMBER_OF': (LOCAL_ONLY, 'store_identity.py'),
    'CONTAINS_PROJECT': (_ENDPOINTS, 'store_projects.py'),
    'PERSONAL_PROJECT_RELATION': (_ENDPOINTS, 'personal_project_hierarchy.py'),
    'FULI_PROJECT_RELATION': (_ENDPOINTS, 'retired_graph_labels.py'),
    'PROJECT_MEMORY_ACCESS': (_ENDPOINTS, 'project_memory_usage.py'),
    'HAS_PERSONAL_PROJECT_RELATION_REVIEW': (_ENDPOINTS, 'personal_project_hierarchy.py'),
    'HAS_KNOWLEDGE_ASSIGNMENT': (_ENDPOINTS, 'knowledge_management.py'),
    'ASSIGNED_TO': (_ENDPOINTS, 'knowledge_management.py'),
    'HAS_KNOWLEDGE_REFERENCE': (_ENDPOINTS, 'project_knowledge.py'),
    'REFERENCES_IN': (_ENDPOINTS, 'project_knowledge.py'),
    'HAS_KNOWLEDGE_REVISION': (_ENDPOINTS, 'knowledge_versions.py'),
    'HAS_KNOWLEDGE_AUDIT': (_ENDPOINTS, 'knowledge_audit.py'),
    'HAS_KNOWLEDGE_CONFLICT': (_ENDPOINTS, 'project_knowledge.py'),
    'HAS_KNOWLEDGE_REVIEW': (_ENDPOINTS, 'knowledge_review.py'),
    'HAS_REVIEW_DECISION': (_ENDPOINTS, 'knowledge_review.py'),
    'HAS_KNOWLEDGE_TAG': (_ENDPOINTS, 'store_knowledge_tags.py'),
    'HAS_TAG_REVISION': (_ENDPOINTS, 'store_knowledge_tags.py'),
    'TAGS': (_ENDPOINTS, 'store_knowledge_tags.py'),
    'HAS_PREFERENCE_CONFLICT': (_ENDPOINTS, 'preference_conflicts.py'),
    'HAS_WORKFLOW_CANDIDATE': (_ENDPOINTS, 'workflow_candidates.py'),
    'HAS_WORKFLOW_AUTHORIZATION': (_ENDPOINTS, 'workflow_candidates.py'),
    'FROM_WORKFLOW_STEP': (_ENDPOINTS, 'workflow_candidates.py'),
    'TO_WORKFLOW_STEP': (_ENDPOINTS, 'workflow_candidates.py'),
    'HAS_PROJECT_AGENT_IDENTITY': (_ENDPOINTS, 'store_project_agents.py'),
    'HAS_PROJECT_AGENT': (_ENDPOINTS, 'graph_format_backfills.py (graph/2 backfill source)'),
    'MERGED_INTO': (_ENDPOINTS, 'system_hr_identity.py'),
    'HAS_OCCUPATION': (_ENDPOINTS, 'store_occupation_catalog.py'),
    'HAS_DISMISSAL': (_ENDPOINTS, 'store_project_agent_dismissal.py'),
    'HAS_PROJECT_AGENT_RECRUITMENT_POLICY': (_ENDPOINTS, 'runtime.py'),
    'HAS_PROJECT_AGENT_ASSIGNMENT': (_ENDPOINTS, 'store_project_agents.py'),
    'ASSIGNED_AGENT': (_ENDPOINTS, 'store_project_agents.py'),
    'HAS_PROJECT_AGENT_COORDINATION_POLICY': (_ENDPOINTS, 'store_project_agent_coordination_policy.py'),
    'HAS_WORKING_MEMORY': (_ENDPOINTS, 'store_project_agent_memory.py'),
    'HAS_AGENT_WORKING_MEMORY': (_ENDPOINTS, 'store_project_agent_memory.py'),
    'HAS_MEMORY_CHECKPOINT': (_ENDPOINTS, 'store_project_agent_memory.py'),
    'HAS_PROJECT_AGENT_RECRUITMENT': (_ENDPOINTS, 'store_project_agent_task_recruitment.py'),
    'TRIGGERED_RECRUITMENT': (_ENDPOINTS, 'store_project_agent_task_recruitment.py'),
    'CREATED_AGENT': (_ENDPOINTS, 'store_project_agent_task_recruitment.py'),
    'RECRUITED_BY': (_ENDPOINTS, 'store_project_agent_task_recruitment.py'),
    'HAS_PROJECT_AGENT_TASK': (_ENDPOINTS, 'store_project_agent_tasks.py'),
    'HAS_TASK_EVENT': (_ENDPOINTS, 'store_project_agent_tasks.py'),
    'EVENT_AGENT': (_ENDPOINTS, 'store_project_agent_task_activity.py'),
    'HAS_PARTICIPANT': (_ENDPOINTS, 'store_project_agent_task_staffing.py'),
    'COORDINATES_TASK': (_ENDPOINTS, 'store_project_agent_tasks.py'),
    'COORDINATED_BY': (_ENDPOINTS, 'store_project_agent_tasks.py'),
    'ROUTED_BY': (_ENDPOINTS, 'store_project_agent_tasks.py'),
    'HAS_VERIFICATION': (_ENDPOINTS, 'store_agent_verification.py'),
    'HAS_WORKER_RUN': (_ENDPOINTS, 'store_project_agent_worker_runs.py'),
    'FOR_WORKER_RUN': (_ENDPOINTS, 'store_project_agent_worker_runs.py'),
    'AUTHORIZES_WORKER_RUN': (_ENDPOINTS, 'store_project_agent_worker_runs.py'),
    'RETRIES_WORKER_RUN': (_ENDPOINTS, 'store_project_agent_worker_runs.py'),
    'WORKER_AGENT': (_ENDPOINTS, 'store_project_agent_worker_runs.py'),
    'BOUND_WORKER_RUN': (_ENDPOINTS, 'store_task_contexts.py (from a session: never exported)'),
    'HAS_AGENT_ATTENTION': (_ENDPOINTS, 'store_project_agent_attention.py'),
    'HAS_TASK_CONTEXT_SESSION': (_ENDPOINTS, 'store_task_contexts.py (to a session: never exported)'),
    'HAS_CONTEXT': (_ENDPOINTS, 'store_task_contexts.py (from a session: never exported)'),
    'HAS_EVENT': (_ENDPOINTS, 'store_agent_conversations.py'),
    'SUBSCRIBES_TO': (_ENDPOINTS, 'store_publication.py'),
    'HAS_PUBLICATION_DRAFT': (_ENDPOINTS, 'store_publication.py'),
    'HAS_RELEASE': (_ENDPOINTS, 'graph_format_backfills.py (shared spaces: never exported)'),
    'HAS_EXECUTOR_PERMISSION': (_ENDPOINTS, 'store_project_agent_executors.py (to an executor: never exported)'),
    'HAS_EXECUTOR_OBSERVATION': (_ENDPOINTS, 'store_project_agent_executors.py (never exported)'),
    'HAS_EXECUTOR_OUTCOME_EVIDENCE': (_ENDPOINTS, 'store_project_agent_executor_learning.py (never exported)'),
    'HAS_FORMAT_EVENT': (_ENDPOINTS, 'graph_format_ledger.py (never exported)'),
    'CHANGED_OCCUPATION': (_ENDPOINTS, 'migrate_lead_occupation.py (never exported)'),
    'OF_AGENT': (_ENDPOINTS, 'migrate_lead_occupation.py (never exported)'),
}

# The relationship types whose own property identifies one of several between
# the same two nodes; every other type is one per (type, start, end).
RELATIONSHIP_KEYS = {
    'RELATES_TO': 'uuid', 'MENTIONS': 'uuid', 'PERSONAL_PROJECT_RELATION': 'id',
    'PROJECT_MEMORY_ACCESS': 'id', 'FULI_PROJECT_RELATION': 'id',
}

# Vectors are an index over an item's text (knowledge_semantic_index.py): a
# copy carries them only for the same model, else the importer computes them
# again. The semantic hash and model go with the vector, or the item would
# look indexed without one.
DERIVED_PROPERTIES = frozenset({
    'name_embedding', 'fact_embedding', 'fuli_semantic_vector', 'fuli_semantic_model', 'fuli_semantic_hash',
})
# CLASSIFICATION DATA END

@dataclass
class GraphNode:
    element_id: str
    label: str
    labels: tuple[str, ...]
    properties: dict
    parents: set[str] = field(default_factory=set)


@dataclass
class GraphRelationship:
    element_id: str
    type: str
    start: str
    end: str
    properties: dict


def exported(rule: NodeRule) -> bool:
    return rule.found is not None


def conversation_scopes(space_id, agent_ids, project_ids) -> dict[str, str | None]:
    """Each conversation journal scope ID of the space, to its project (None:
    the Agent's global journal). Every pair is listed, not only the
    assignments a conversation was opened under."""
    return {conversation_scope_id(space_id, project, agent): project
            for agent in agent_ids for project in (None, *project_ids)}


def _project_values(properties: dict, names) -> set[str]:
    projects = set()
    for name in names:
        value = properties.get(name)
        values = value if isinstance(value, list) else [value]
        projects.update(project_scope(item) for item in values if isinstance(item, str) and item)
    return projects


def _cross(scopes: set[str]) -> set[str]:
    """A record between a global end and a project end belongs to the project."""
    projects = {scope for scope in scopes if scope.startswith(PROJECT_PREFIX)}
    return projects or scopes


class ScopeClassification:
    """The scopes of every node and relationship one personal space read gave.

    nodes and relationships are what scope_export read; local_only and derived
    labels are never read, so a relationship to one of them has an end that is
    not here and is never exported."""

    def __init__(self, space_element_id, nodes: dict[str, GraphNode], relationships: list[GraphRelationship],
                 conversations: dict[str, str | None]):
        self.space_element_id = space_element_id
        self.nodes = nodes
        self.relationships = relationships
        self.conversations = conversations
        # The knowledge items each record's scope came from, for externalRefs.
        self.references: dict[str, set[str]] = defaultdict(set)
        self.project_ids = {node.properties.get('project_id') for node in nodes.values()
                            if node.label == 'FuliPersonalProject'}
        self._by_type = defaultdict(list)
        for relationship in relationships:
            self._by_type[relationship.type].append(relationship)
        self._items = self._item_index()
        self._primary, self._references = self._assignments()
        self._mentions = defaultdict(list)
        self._mentioned_by = defaultdict(list)
        for relationship in self._by_type['MENTIONS']:
            if relationship.start in nodes and relationship.end in nodes:
                self._mentions[relationship.start].append(relationship.end)
                self._mentioned_by[relationship.end].append(nodes[relationship.start].properties.get('uuid'))
        self._node_scopes: dict[str, frozenset[str]] = {}
        self._fact_scopes = {relationship.element_id: frozenset(self._fact_own(relationship))
                             for relationship in self._by_type['RELATES_TO']}
        self._entity_facts = defaultdict(set)
        for relationship in self._by_type['RELATES_TO']:
            for end in (relationship.start, relationship.end):
                self._entity_facts[end] |= self._fact_scopes[relationship.element_id]

    # Knowledge items -----------------------------------------------------

    def _item_index(self) -> dict[tuple[str, str], str]:
        index = {}
        for element_id, node in self.nodes.items():
            if node.label in ('Entity', 'Episodic'):
                index[('entity' if node.label == 'Entity' else 'episode', node.properties.get('uuid'))] = element_id
        for relationship in self._by_type['RELATES_TO']:
            index[('relationship', relationship.properties.get('uuid'))] = relationship.element_id
        return index

    def _assignments(self) -> tuple[dict, dict]:
        """Each item's primary project and its active project references."""
        primary, references = {}, defaultdict(set)
        for node in self.nodes.values():
            key = (node.properties.get('item_kind'), node.properties.get('item_id'))
            if node.label == 'FuliKnowledgeAssignment' and node.properties.get('project_id'):
                primary[key] = node.properties['project_id']
            elif (node.label == 'FuliKnowledgeProjectReference'
                  and node.properties.get('status') == 'active' and node.properties.get('project_id')):
                references[key].add(node.properties['project_id'])
        return primary, references

    def _episode_projects(self, uuids) -> set[str]:
        projects = set()
        for uuid in uuids:
            episode = self.nodes.get(self._items.get(('episode', uuid)))
            if episode is not None:
                projects |= _project_values(episode.properties, ('fuli_personal_project_id',))
        return projects

    def _item_own(self, kind: str, properties: dict, source_episodes) -> set[str]:
        """A preference by its own scope fields (collaboration_context.py); any
        other item by its assignment, else its sources' projects, plus its
        active project references (knowledge_project_scope.py)."""
        if properties.get('fuli_profile_aspect') is not None:
            scope = properties.get('fuli_preference_scope') or 'global'
            if scope == 'global':
                return {GLOBAL}
            projects = _project_values(properties, ('fuli_preference_project_id', 'fuli_preference_project_ids'))
            if scope == 'project' and properties.get('fuli_inheritance_mode') == 'selected_projects':
                projects |= _project_values(properties, ('fuli_inherited_project_ids',))
            return projects or {GLOBAL}
        key = (kind, properties.get('uuid'))
        projects = ({project_scope(self._primary[key])} if key in self._primary
                    else self._episode_projects(source_episodes))
        return projects | {project_scope(project) for project in self._references.get(key, ())}

    def _fact_own(self, relationship: GraphRelationship) -> set[str]:
        properties = relationship.properties
        return self._item_own('relationship', properties, properties.get('episodes') or []) or {GLOBAL}

    def _entity_scopes(self, element_id: str, node: GraphNode) -> set[str]:
        """An entity also goes wherever a fact it is an end of goes, so a
        scope's facts never point at an entity the scope lacks."""
        return (self._item_own('entity', node.properties, self._mentioned_by.get(element_id, ()))
                | self._entity_facts.get(element_id, set())) or {GLOBAL}

    def _evidence_scopes(self, element_id: str, node: GraphNode) -> set[str]:
        """An episode is evidence for every item it mentions, and belongs to its own project."""
        scopes = _project_values(node.properties, ('fuli_personal_project_id',))
        for entity in self._mentions.get(element_id, ()):
            scopes |= self.node_scopes(entity)
        for uuid in node.properties.get('entity_edges') or []:
            fact = self._items.get(('relationship', uuid))
            if fact is not None:
                scopes |= self._fact_scopes[fact]
        return scopes or {GLOBAL}

    def item_scopes(self, kind, item_id, *, referrer: str) -> set[str] | None:
        """The scopes of the knowledge item a record is about; None when it is gone."""
        element_id = self._items.get((kind, item_id))
        if element_id is None:
            return None
        self.references[referrer].add(element_id)
        if element_id in self._fact_scopes:
            return set(self._fact_scopes[element_id])
        return set(self.node_scopes(element_id))

    # Every node -----------------------------------------------------------

    def node_scopes(self, element_id: str) -> frozenset[str]:
        if element_id not in self._node_scopes:
            node = self.nodes[element_id]
            scopes = self._judge(element_id, node, NODE_RULES[node.label].judge)
            if not any(self._exportable(scope) for scope in scopes) and scopes.isdisjoint({LOCAL_ONLY, DERIVED}):
                # Every project it names is gone: it stays with the person.
                scopes = scopes | {GLOBAL}
            self._node_scopes[element_id] = frozenset(scopes)
        return self._node_scopes[element_id]

    def _exportable(self, scope: str) -> bool:
        return scope == GLOBAL or scope.removeprefix(PROJECT_PREFIX) in self.project_ids

    def _judge(self, element_id: str, node: GraphNode, judge: tuple) -> set[str]:
        kind, *arguments = judge
        properties = node.properties
        if kind == 'fixed':
            return {arguments[0]}
        if kind == 'projects':
            return _project_values(properties, arguments[0]) or {GLOBAL}
        if kind == 'project':
            return {project_scope(properties['project_id'])}
        if kind == 'parent':
            scopes = set()
            for parent in node.parents:
                scopes |= self.node_scopes(parent)
            return scopes
        if kind == 'knowledge':
            return self._entity_scopes(element_id, node)
        if kind == 'evidence':
            return self._evidence_scopes(element_id, node)
        if kind == 'item':
            kind_property, id_property, fallback = arguments
            found = self.item_scopes(properties.get(kind_property), properties.get(id_property),
                                     referrer=element_id)
            return found if found is not None else (_project_values(properties, fallback) or {GLOBAL})
        if kind == 'items':
            pairs, fallback = arguments
            scopes = set()
            for kind_property, id_property in pairs:
                scopes |= self.item_scopes(properties.get(kind_property), properties.get(id_property),
                                           referrer=element_id) or set()
            return _cross(scopes | _project_values(properties, fallback)) or {GLOBAL}
        if kind == 'conversation':
            scope_id = properties.get(arguments[0])
            if scope_id not in self.conversations:
                # A journal of no Agent this space knows: kept here, never guessed.
                return {LOCAL_ONLY}
            project = self.conversations[scope_id]
            return {project_scope(project)} if project else {GLOBAL}
        if kind == 'relation':
            relation_id = properties.get(arguments[0])
            for relationship in self._by_type['PERSONAL_PROJECT_RELATION']:
                if relationship.properties.get('id') == relation_id:
                    return set(self.relationship_scopes(relationship)) or {GLOBAL}
            return {GLOBAL}
        raise ValueError(f'unknown scope judge {kind}')

    def relationship_scopes(self, relationship: GraphRelationship) -> frozenset[str]:
        rule, _ = RELATIONSHIP_RULES.get(relationship.type, (None, None))
        if rule in (None, LOCAL_ONLY) or not (self._present(relationship.start) and self._present(relationship.end)):
            return frozenset()
        if rule == 'item':
            return self._fact_scopes[relationship.element_id]
        start, end = self._end_scopes(relationship.start), self._end_scopes(relationship.end)
        if LOCAL_ONLY in (start or ()) or LOCAL_ONLY in (end or ()):
            return frozenset()
        if start is None:
            return frozenset(end)
        if end is None:
            return frozenset(start)
        cross = {scope for scope in start ^ end if scope.startswith(PROJECT_PREFIX)}
        return frozenset((start & end) | cross)

    def _present(self, element_id: str) -> bool:
        return element_id == self.space_element_id or element_id in self.nodes

    def _end_scopes(self, element_id: str) -> frozenset[str] | None:
        """None for the space, which every scope has."""
        return None if element_id == self.space_element_id else self.node_scopes(element_id)
