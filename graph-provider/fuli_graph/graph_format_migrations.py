"""Every registered graph migration, in version order (rec#17 D-09).

Nothing outside this registry changes the graph's format: graph_format.py runs
the schema steps and counts what the record-changing steps would still change.
A new constraint, index or Fuli label is a new entry here with the next version.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from . import graph_format_backfills as backfills
from .graph_format_schema import (
    BASELINE_LABELS,
    BASELINE_RULES,
    CONTROL_PLANE_RULES,
    SchemaRule,
)

# The automatic whitelist. A schema step adds only declared indexes and
# constraints, after a uniqueness preflight, and changes no record. Neo4j has
# no in-process backup, so nothing else may run without a person.
AUTOMATIC_KINDS = frozenset({'schema'})
RECORD_KINDS = frozenset({'backfill', 'rewrite'})


@dataclass(frozen=True)
class GraphMigration:
    id: str
    to_version: int
    kind: str
    summary: str
    rules: tuple[SchemaRule, ...] = ()
    labels: frozenset[str] = frozenset()
    # Record-changing steps: how many records still need the step, and the
    # step itself, which only a confirmed migration runs.
    pending: Callable[..., Awaitable[int]] | None = None
    apply: Callable[..., Awaitable[None]] | None = None

    @property
    def from_version(self) -> int:
        return self.to_version - 1

    @property
    def automatic(self) -> bool:
        return self.kind in AUTOMATIC_KINDS


def _records(migration_id, to_version, kind, summary, pending, apply) -> GraphMigration:
    return GraphMigration(migration_id, to_version, kind, summary, pending=pending, apply=apply)


GRAPH_MIGRATIONS = (
    GraphMigration(
        'graph/1-baseline-schema', 1, 'schema',
        'Graphiti indexes and the first FULI identity constraints',
        rules=BASELINE_RULES, labels=BASELINE_LABELS,
    ),
    _records(
        'graph/2-learning-bucket-ids', 2, 'rewrite',
        'stable IDs for executor learning caches; older duplicate projections are deleted',
        backfills.pending_learning_bucket_ids, backfills.apply_learning_bucket_ids,
    ),
    GraphMigration(
        'graph/3-control-plane-schema', 3, 'schema',
        'Project Agent control-plane constraints and lookup indexes',
        rules=CONTROL_PLANE_RULES,
    ),
    _records(
        'graph/4-legacy-agent-assignments', 4, 'backfill',
        'space identities and assignment history for project-bound legacy Agents',
        backfills.pending_legacy_agent_assignments, backfills.apply_legacy_agent_assignments,
    ),
    _records(
        'graph/5-knowledge-lifecycle-defaults', 5, 'backfill',
        'usage, confidence and inheritance defaults on knowledge items',
        backfills.pending_knowledge_lifecycle_defaults,
        backfills.apply_knowledge_lifecycle_defaults,
    ),
    _records(
        'graph/6-project-relation-review-defaults', 6, 'backfill',
        'review status and revision on personal project relations',
        backfills.pending_project_relation_review_defaults,
        backfills.apply_project_relation_review_defaults,
    ),
    _records(
        'graph/7-space-visibility-owners', 7, 'backfill',
        'space visibility and the owner of maintained project spaces',
        backfills.pending_space_visibility_and_owners,
        backfills.apply_space_visibility_and_owners,
    ),
    _records(
        'graph/8-project-release-records', 8, 'backfill',
        'a legacy release record for public projects published before releases',
        backfills.pending_project_release_records, backfills.apply_project_release_records,
    ),
    _records(
        'graph/9-group-id-separators', 9, 'rewrite',
        "Graphiti group IDs without ':' on every node and relationship of a space",
        backfills.pending_group_id_separators, backfills.apply_group_id_separators,
    ),
)

GRAPH_FORMAT_VERSION = GRAPH_MIGRATIONS[-1].to_version


def _validate(migrations: tuple[GraphMigration, ...]) -> None:
    for expected, migration in enumerate(migrations, start=1):
        if migration.to_version != expected:
            raise ValueError(f'{migration.id} must move the graph to version {expected}')
        if migration.automatic and not migration.rules and not migration.labels:
            raise ValueError(f'{migration.id} declares no schema')
        if migration.kind in RECORD_KINDS and not (migration.pending and migration.apply):
            raise ValueError(f'{migration.id} must count and apply its record changes')
        if migration.kind not in AUTOMATIC_KINDS | RECORD_KINDS:
            raise ValueError(f'{migration.id} has an unknown kind {migration.kind}')


_validate(GRAPH_MIGRATIONS)
