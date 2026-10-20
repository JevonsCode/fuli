"""The graph's declared schema: every constraint and index FULI creates, and
every Fuli node label its code writes, grouped by the format version that
introduced them (rec#17 D-09).

Only graph_format.py runs these statements. A constraint, index or label that
is not declared here fails the format fingerprint test, and a declaration that
changes after it shipped changes its version's fingerprint; both mean a new
version with its own registered migration (graph_format_migrations.py).
"""

from dataclasses import dataclass
import json
import re

from graphiti_core.driver.driver import GraphProvider
from graphiti_core.graph_queries import get_fulltext_indices, get_range_indices

from .provider_values import sha256_text

_RULE_NAME = re.compile(r'\b(?:CONSTRAINT|INDEX)\s+(\w+)\s+IF NOT EXISTS\b')


@dataclass(frozen=True)
class SchemaRule:
    name: str
    cypher: str
    # A uniqueness rule names what it constrains, so existing data can be
    # checked for duplicates before the constraint is created.
    unique_label: str | None = None
    unique_properties: tuple[str, ...] = ()


def _unique(name: str, label: str, *properties: str) -> SchemaRule:
    target = (
        f'n.{properties[0]}' if len(properties) == 1
        else '(' + ', '.join(f'n.{item}' for item in properties) + ')'
    )
    return SchemaRule(
        name,
        f'CREATE CONSTRAINT {name} IF NOT EXISTS FOR (n:{label}) REQUIRE {target} IS UNIQUE',
        unique_label=label,
        unique_properties=properties,
    )


def _node_index(name: str, label: str, *properties: str) -> SchemaRule:
    columns = ', '.join(f'n.{item}' for item in properties)
    return SchemaRule(name, f'CREATE INDEX {name} IF NOT EXISTS FOR (n:{label}) ON ({columns})')


def _relationship_index(name: str, relationship: str, *properties: str) -> SchemaRule:
    columns = ', '.join(f'r.{item}' for item in properties)
    return SchemaRule(
        name, f'CREATE INDEX {name} IF NOT EXISTS FOR ()-[r:{relationship}]-() ON ({columns})'
    )


def _graphiti_rules() -> tuple[SchemaRule, ...]:
    """Graphiti's own indexes, read from the pinned graphiti-core: a dependency
    upgrade that changes them changes the baseline fingerprint."""
    statements = [
        *get_range_indices(GraphProvider.NEO4J),
        *get_fulltext_indices(GraphProvider.NEO4J),
    ]
    rules = []
    for statement in statements:
        match = _RULE_NAME.search(statement)
        if not match:
            raise ValueError(f'graphiti index has no stable name: {statement}')
        rules.append(SchemaRule(match.group(1), ' '.join(statement.split())))
    return tuple(rules)


BASELINE_RULES = (
    *_graphiti_rules(),
    _unique('fuli_principal_id', 'FuliPrincipal', 'id'),
    _unique('fuli_space_id', 'FuliSpace', 'id'),
    _unique('fuli_subscription_id', 'FuliSubscription', 'id'),
    _unique('fuli_proposal_id', 'FuliProposal', 'id'),
    _unique('fuli_personal_project_id', 'FuliPersonalProject', 'id'),
    _unique('fuli_publication_draft_id', 'FuliPublicationDraft', 'id'),
    _unique('fuli_project_release_id', 'FuliProjectRelease', 'id'),
    _unique('fuli_knowledge_reference_id', 'FuliKnowledgeProjectReference', 'id'),
    _unique('fuli_knowledge_conflict_id', 'FuliKnowledgeConflict', 'id'),
    _unique('fuli_knowledge_audit_id', 'FuliKnowledgeAudit', 'id'),
    _unique('fuli_knowledge_review_id', 'FuliKnowledgeReviewRun', 'id'),
    _unique('fuli_knowledge_review_active', 'FuliKnowledgeReviewRun', 'active_key'),
    _unique('fuli_knowledge_review_decision_id', 'FuliKnowledgeReviewDecision', 'id'),
    _unique('fuli_workflow_candidate_id', 'FuliWorkflowCandidate', 'id'),
    _unique('fuli_workflow_review_event_id', 'FuliWorkflowReviewEvent', 'id'),
    _unique('fuli_workflow_review_preview_id', 'FuliWorkflowReviewPreview', 'id'),
    _unique('fuli_workflow_review_preview_token', 'FuliWorkflowReviewPreview', 'token_hash'),
    _unique('fuli_agent_delegation_token', 'FuliAgentDelegation', 'token_hash'),
    _unique('fuli_workflow_rule_id', 'FuliWorkflowRule', 'id'),
    _unique('fuli_workflow_authorization_id', 'FuliWorkflowAuthorization', 'id'),
    _unique('fuli_personal_global_preference_decision', 'FuliPersonalGlobalPreferenceDecision', 'space_id', 'candidate_id'),
    _unique('fuli_personal_global_preference_event', 'FuliPersonalGlobalPreferenceDecisionEvent', 'id'),
    _unique('fuli_personal_global_preference_preview', 'FuliPersonalGlobalPreferenceDecisionPreview', 'id'),
    _unique('fuli_personal_global_preference_preview_token', 'FuliPersonalGlobalPreferenceDecisionPreview', 'token_hash'),
    _unique('fuli_personal_project_relation_review', 'FuliPersonalProjectRelationReview', 'id'),
)

# Added once legacy learning buckets have stable IDs (graph/2), so the
# uniqueness of those IDs is created after the duplicates were collapsed.
CONTROL_PLANE_RULES = (
    _unique('fuli_agent_verification_id', 'FuliAgentVerification', 'id'),
    _unique('fuli_agent_loan_id', 'FuliAgentLoan', 'id'),
    _unique('fuli_transcript_cursor_id', 'FuliTranscriptCursor', 'id'),
    _unique('fuli_conversation_id', 'FuliConversation', 'id'),
    _unique('fuli_conversation_event', 'FuliConversationEvent', 'id'),
    _unique('fuli_conversation_binding', 'FuliConversationBinding', 'id'),
    _unique('fuli_conversation_policy', 'FuliConversationPolicy', 'id'),
    _unique('fuli_project_agent_id', 'FuliProjectAgent', 'id'),
    _unique('fuli_project_agent_employee_number', 'FuliProjectAgent', 'employee_number_space_id', 'employee_number'),
    _unique('fuli_agent_attention_id', 'FuliAgentAttention', 'id'),
    _unique('fuli_project_agent_assignment_id', 'FuliProjectAgentAssignment', 'id'),
    _unique('fuli_project_agent_memory_id', 'FuliProjectAgentMemory', 'id'),
    _unique('fuli_project_agent_memory_checkpoint_id', 'FuliProjectAgentMemoryCheckpoint', 'id'),
    _unique('fuli_task_context_session_id', 'FuliTaskContextSession', 'id'),
    _unique('fuli_task_context_id', 'FuliTaskContext', 'id'),
    _unique('fuli_project_agent_worker_run_id', 'FuliProjectAgentWorkerRun', 'id'),
    _unique('fuli_project_agent_worker_capability', 'FuliProjectAgentWorkerRun', 'runtime_capability_hash'),
    _unique('fuli_project_agent_worker_session', 'FuliProjectAgentWorkerRun', 'target_application', 'actual_session_id'),
    _node_index('fuli_task_context_agent_scope', 'FuliTaskContext', 'personal_space_id', 'project_agent_id'),
    _unique('fuli_project_agent_task_id', 'FuliProjectAgentTask', 'id'),
    _unique('fuli_project_agent_task_event_id', 'FuliProjectAgentTaskEvent', 'id'),
    _unique('fuli_project_agent_routing_decision_id', 'FuliProjectAgentRoutingDecision', 'id'),
    _unique('fuli_project_agent_recruitment_id', 'FuliProjectAgentRecruitment', 'id'),
    _unique('fuli_project_agent_recruitment_policy_space', 'FuliProjectAgentRecruitmentPolicy', 'personal_space_id'),
    _unique('fuli_project_agent_executor_id', 'FuliProjectAgentExecutor', 'id'),
    _unique('fuli_project_agent_executor_routing_rule_id', 'FuliProjectAgentExecutorRoutingRule', 'id'),
    _unique('fuli_project_agent_executor_decision_id', 'FuliProjectAgentExecutorDecision', 'id'),
    _unique('fuli_project_agent_executor_outcome_evidence_id', 'FuliProjectAgentExecutorOutcomeEvidence', 'id'),
    _unique('fuli_project_agent_executor_outcome_aggregate_id', 'FuliProjectAgentExecutorOutcomeAggregate', 'id'),
    _unique('fuli_project_agent_executor_outcome_reset_id', 'FuliProjectAgentExecutorOutcomeReset', 'id'),
    _unique('fuli_project_agent_executor_observation_id', 'FuliProjectAgentExecutorObservation', 'id'),
    _unique('fuli_remote_origin_key_space', 'FuliRemoteOriginKey', 'space_id'),
    _unique('fuli_remote_agent_origin_message', 'FuliRemoteAgentOrigin', 'space_id', 'message_id'),
    _unique('fuli_remote_delegation_attempt', 'FuliRemoteDelegationAttempt', 'space_id', 'origin_node', 'origin_message_id', 'origin_attempt_id'),
    _node_index('fuli_entity_confirmation', 'Entity', 'group_id', 'fuli_confirmation_status'),
    _node_index('fuli_entity_usage_score', 'Entity', 'group_id', 'fuli_utility_score'),
    _relationship_index('fuli_relationship_confirmation', 'RELATES_TO', 'group_id', 'fuli_confirmation_status'),
    _relationship_index('fuli_relationship_usage_score', 'RELATES_TO', 'group_id', 'fuli_utility_score'),
    _node_index('fuli_knowledge_assignment_lookup', 'FuliKnowledgeAssignment', 'space_id', 'item_kind', 'item_id'),
    _node_index('fuli_knowledge_reference_lookup', 'FuliKnowledgeProjectReference', 'space_id', 'item_kind', 'item_id'),
    _node_index('fuli_knowledge_audit_lookup', 'FuliKnowledgeAudit', 'space_id', 'item_id', 'usage_generation'),
    _node_index('fuli_knowledge_review_scope', 'FuliKnowledgeReviewRun', 'personal_space_id', 'scope_key', 'status'),
    _relationship_index('fuli_personal_project_relation_type', 'PERSONAL_PROJECT_RELATION', 'relation_type'),
    _node_index('fuli_project_agent_assignment_lookup', 'FuliProjectAgentAssignment', 'status', 'assigned_at'),
    _node_index('fuli_project_agent_task_lookup', 'FuliProjectAgentTask', 'personal_space_id', 'personal_project_id', 'status'),
    _node_index('fuli_project_agent_event_activity', 'FuliProjectAgentTaskEvent', 'agent_id', 'activity_date', 'status'),
    _node_index('fuli_project_agent_executor_eligibility', 'FuliProjectAgentExecutor', 'personal_space_id', 'registration_status', 'preflight_status', 'health_status'),
    _node_index('fuli_project_agent_executor_rule_scope', 'FuliProjectAgentExecutorRoutingRule', 'personal_space_id', 'scope', 'personal_project_id', 'task_id'),
    _node_index('fuli_project_agent_executor_evidence_lookup', 'FuliProjectAgentExecutorOutcomeEvidence', 'personal_space_id', 'agent_id', 'work_kind', 'executor_id', 'occurred_at'),
    _node_index('fuli_project_agent_aggregate_lookup', 'FuliProjectAgentExecutorOutcomeAggregate', 'personal_space_id', 'personal_project_id', 'agent_id', 'work_kind', 'executor_id', 'model_strategy_key'),
)

# Every Fuli label in the code when the format registry was introduced.
BASELINE_LABELS = frozenset({
    'FuliAgentAttention',
    'FuliAgentDelegation',
    'FuliAgentLoan',
    'FuliAgentVerification',
    'FuliCommonKnowledgePromotion',
    'FuliConversation',
    'FuliConversationBinding',
    'FuliConversationEvent',
    'FuliConversationPolicy',
    'FuliConversationTopicDecline',
    'FuliConversationTriage',
    'FuliKnowledgeAssignment',
    'FuliKnowledgeAudit',
    'FuliKnowledgeConflict',
    'FuliKnowledgeProjectReference',
    'FuliKnowledgeReviewDecision',
    'FuliKnowledgeReviewRun',
    'FuliKnowledgeRevision',
    'FuliLeadOccupationChange',
    'FuliLeadOccupationMigration',
    'FuliOccupation',
    'FuliPersonalGlobalPreferenceDecision',
    'FuliPersonalGlobalPreferenceDecisionEvent',
    'FuliPersonalGlobalPreferenceDecisionPreview',
    'FuliPersonalProject',
    'FuliPersonalProjectRelationReview',
    'FuliPreferenceConflict',
    'FuliPrincipal',
    'FuliProjectAgent',
    'FuliProjectAgentAlias',
    'FuliProjectAgentAssignment',
    'FuliProjectAgentCoordinationPolicy',
    'FuliProjectAgentDismissal',
    'FuliProjectAgentExecutor',
    'FuliProjectAgentExecutorDecision',
    'FuliProjectAgentExecutorObservation',
    'FuliProjectAgentExecutorOutcomeAggregate',
    'FuliProjectAgentExecutorOutcomeEvidence',
    'FuliProjectAgentExecutorOutcomeReset',
    'FuliProjectAgentExecutorRoutingRule',
    'FuliProjectAgentMemory',
    'FuliProjectAgentMemoryCheckpoint',
    'FuliProjectAgentRecruitment',
    'FuliProjectAgentRecruitmentPolicy',
    'FuliProjectAgentRoutingDecision',
    'FuliProjectAgentTask',
    'FuliProjectAgentTaskEvent',
    'FuliProjectAgentWorkerRun',
    'FuliProjectRelease',
    'FuliProposal',
    'FuliPublicationDraft',
    'FuliRemoteAgentOrigin',
    'FuliRemoteDelegationAttempt',
    'FuliRemoteOriginKey',
    'FuliSpace',
    'FuliSubscription',
    'FuliTaskContext',
    'FuliTaskContextSession',
    'FuliTranscriptCursor',
    'FuliWorkflowAuthorization',
    'FuliWorkflowCandidate',
    'FuliWorkflowReviewEvent',
    'FuliWorkflowReviewPreview',
    'FuliWorkflowRule',
})


def schema_fingerprint(rules: tuple[SchemaRule, ...], labels: frozenset[str]) -> str:
    """One version's declared schema as a stable digest, kept in the ledger."""
    document = {
        'rules': sorted(rule.cypher for rule in rules),
        'labels': sorted(labels),
    }
    return sha256_text(json.dumps(document, ensure_ascii=False, separators=(',', ':')))
