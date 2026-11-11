"""Node labels earlier FULI versions wrote and no code writes or reads now.

The stored graph format is frozen: a graph that has these nodes keeps them,
and the migrations that declared their labels keep declaring them. They are
named here, as Cypher patterns, so the format check
(tests/test_graph_format.py) still sees every declared label in the code and
a future cleanup migration has one place to start from.

Retired on 2026-11-11 with their features: the personal-global preference
decision preview (it could never be applied) and the workflow candidate
review with its rules (nothing recorded observations to review).
"""

RETIRED_NODE_PATTERNS = (
    '(:FuliPersonalGlobalPreferenceDecisionPreview)',
    '(:FuliWorkflowReviewPreview)',
    '(:FuliWorkflowReviewEvent)',
    '(:FuliWorkflowRule)',
)
