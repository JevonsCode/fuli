# Tag search ranking (D-31)

Search ranks only candidates already admitted by the existing space, project,
confirmation, history and basis filters. Tag governance never introduces an item
or overrides deterministic preference loading. After authority and negative
feedback weights, the strongest matching tag applies a multiplier: active direct
or merged redirect 1.25, active one-hop 1.10, provisional direct 1.08, otherwise 1.
Multiple hits do not stack. A requires-attention factor of 0.6 remains below an
otherwise identical unaffected item even with the strongest tag signal.

The query is normalized with the vocabulary's name identity. Exact full phrases
and contiguous whitespace-delimited phrases up to six words match names and
aliases; punctuation is preserved (`C++` is not `C`). Proposed aliases never
participate. Unconfirmed aliases contribute only the provisional tier. Active
parent queries reach immediate children only. Related tags work in both
directions, once. Both ends of a one-hop relation must be active. Redirects reuse
the bounded vocabulary resolver and cannot cross into a hidden namespace.

Equal final scores preserve original rank; equal original scores use scope
precedence and item ID. Entity and relationship ranks are separate, as are their
existing result limits.

## Optional detail explanation

The ordinary search and detail response fields are unchanged. No chat tool or
chat schema field is added. The console's existing item detail GET accepts an
optional `query_tags` query parameter containing a JSON SearchRequest:

```json
{
  "space_ids": ["the-item-personal-space"],
  "query": "deployment",
  "personal_project_ids": ["the-search-project"],
  "include_personal_global": true,
  "limit": 10
}
```

The request must name exactly the item's personal space. Normal item and search
authorization still apply. Only an explicit request returns `tag_ranking` with
the target item's original/final ranks and scores, strongest multiplier, matching
tags and method (`direct`, `redirect_from`, `child_of`, `related_to`), status,
tier, inferred/unconfirmed flags, or a reason no signal applied. Ranks describe
the current candidate set before the result limit; they recompute current graph
state, not a historical search replay. An item excluded by normal search has no
rank and the reason `not_in_visible_candidates`.

Synthetic coverage is in `test_tag_search_ranking.py`,
`test_tag_ranking_detail_http.py`, and the opt-in
`test_tag_search_ranking_neo4j.py`. The latter requires the existing disposable
loopback `FULI_TEST_NEO4J_*` fixture and never calls a model.
