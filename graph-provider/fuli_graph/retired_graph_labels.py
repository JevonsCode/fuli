"""Node labels and properties earlier FULI versions wrote and no code writes
or reads now.

The stored graph format is frozen: a graph that has these nodes keeps them,
and the migrations that declared their labels keep declaring them. They are
named here, as Cypher patterns, so the format checks
(tests/test_graph_format.py, tests/test_graph_field_contract.py) still see
every declared label and property in the code and a future cleanup migration
has one place to start from.

Retired on 2026-11-11 with their features: the personal-global preference
decision preview (it could never be applied), the workflow candidate review
with its rules (nothing recorded observations to review), and public projects
(team proposals, project-to-project relations and common-knowledge
promotion; the promotion records a person already has stay readable and
hard-deletable).
"""

RETIRED_NODE_PATTERNS = (
    '(:FuliPersonalGlobalPreferenceDecisionPreview)',
    '(:FuliWorkflowReviewPreview)',
    '(:FuliWorkflowReviewEvent)',
    '(:FuliWorkflowRule)',
    '(:FuliProposal {submitted_by, decision_note})',
)

RETIRED_PROPERTY_PATTERNS = (
    '()-[:FULI_PROJECT_RELATION {decision_note}]->()',
    '(:FuliCommonKnowledgePromotion {duplicate_item_ids})',
)
