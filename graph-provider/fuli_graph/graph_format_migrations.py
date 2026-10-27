"""Every registered graph migration, in version order (rec#17 D-09).

Nothing outside this registry changes the graph's format: graph_format.py runs
the schema steps and counts what the record-changing steps would still change.
A new constraint, index or Fuli label is a new entry here with the next version.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from . import graph_format_backfills as backfills
from . import graph_format_builtin_occupations as builtin_occupations
from .graph_format_journal import RecordJournal
from .graph_format_schema import (
    BASELINE_LABELS,
    BASELINE_RULES,
    CONTROL_PLANE_RULES,
    KNOWLEDGE_TAG_LABELS,
    KNOWLEDGE_TAG_RULES,
    SOURCE_DELETE_RULES,
    TASK_BLOCKER_RULES,
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
    # A schema step that only extends the stored field contract
    # (graph_field_contract.py) runs no DDL and changes no record: its version
    # alone makes an older guarded FULI refuse values it has never seen.
    fields_only: bool = False
    # Record-changing steps: the IDs of the records that still need the step,
    # the step itself, which only a confirmed migration runs, and what it may
    # change so that it can be undone (graph_format_journal.py).
    pending: Callable[..., Awaitable[list[str]]] | None = None
    apply: Callable[..., Awaitable[None]] | None = None
    journal: RecordJournal | None = None

    @property
    def from_version(self) -> int:
        return self.to_version - 1

    @property
    def automatic(self) -> bool:
        return self.kind in AUTOMATIC_KINDS


def _records(migration_id, to_version, kind, summary, pending, apply, journal) -> GraphMigration:
    return GraphMigration(
        migration_id, to_version, kind, summary, pending=pending, apply=apply, journal=journal
    )


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
        backfills.LEARNING_BUCKET_JOURNAL,
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
        backfills.LEGACY_AGENT_JOURNAL,
    ),
    _records(
        'graph/5-knowledge-lifecycle-defaults', 5, 'backfill',
        'usage, confidence and inheritance defaults on knowledge items',
        backfills.pending_knowledge_lifecycle_defaults,
        backfills.apply_knowledge_lifecycle_defaults,
        backfills.KNOWLEDGE_LIFECYCLE_JOURNAL,
    ),
    _records(
        'graph/6-project-relation-review-defaults', 6, 'backfill',
        'review status and revision on personal project relations',
        backfills.pending_project_relation_review_defaults,
        backfills.apply_project_relation_review_defaults,
        backfills.RELATION_REVIEW_JOURNAL,
    ),
    _records(
        'graph/7-space-visibility-owners', 7, 'backfill',
        'space visibility and the owner of maintained project spaces',
        backfills.pending_space_visibility_and_owners,
        backfills.apply_space_visibility_and_owners,
        backfills.SPACE_VISIBILITY_JOURNAL,
    ),
    _records(
        'graph/8-project-release-records', 8, 'backfill',
        'a legacy release record for public projects published before releases',
        backfills.pending_project_release_records, backfills.apply_project_release_records,
        backfills.RELEASE_RECORD_JOURNAL,
    ),
    _records(
        'graph/9-group-id-separators', 9, 'rewrite',
        "Graphiti group IDs without ':' on every node and relationship of a space",
        backfills.pending_group_id_separators, backfills.apply_group_id_separators,
        backfills.GROUP_ID_JOURNAL,
    ),
    GraphMigration(
        'graph/10-knowledge-tags', 10, 'schema',
        'open tag vocabulary: tag identity constraints and the tag link lookup index',
        rules=KNOWLEDGE_TAG_RULES, labels=KNOWLEDGE_TAG_LABELS,
    ),
    GraphMigration(
        'graph/11-source-hard-delete', 11, 'schema',
        'source deletion audit kinds and publication copies without source bodies',
        rules=SOURCE_DELETE_RULES,
    ),
    _records(
        'graph/12-builtin-occupations', 12, 'rewrite',
        "Bole's built-in occupation becomes Agent resources (hr), and hr's shipped name and "
        'duties are reworded for Agents; values a person changed stay',
        builtin_occupations.pending_builtin_occupations,
        builtin_occupations.apply_builtin_occupations,
        builtin_occupations.BUILTIN_OCCUPATION_JOURNAL,
    ),
    GraphMigration(
        'graph/13-task-blocker-clear', 13, 'schema',
        'why a task block ended on its event, and the session lookup that ends it',
        rules=TASK_BLOCKER_RULES,
    ),
    GraphMigration(
        'graph/14-person-blocker-clear', 14, 'schema',
        "a task block the person marked cleared in the console (blocker_cleared_by 'person')",
        fields_only=True,
    ),
)

GRAPH_FORMAT_VERSION = GRAPH_MIGRATIONS[-1].to_version


def _validate(migrations: tuple[GraphMigration, ...]) -> None:
    for expected, migration in enumerate(migrations, start=1):
        if migration.to_version != expected:
            raise ValueError(f'{migration.id} must move the graph to version {expected}')
        if migration.automatic and not (migration.rules or migration.labels or migration.fields_only):
            raise ValueError(f'{migration.id} declares no schema')
        if migration.kind in RECORD_KINDS and not (
            migration.pending and migration.apply and migration.journal
        ):
            raise ValueError(f'{migration.id} must name, apply and journal its record changes')
        if migration.kind not in AUTOMATIC_KINDS | RECORD_KINDS:
            raise ValueError(f'{migration.id} has an unknown kind {migration.kind}')


_validate(GRAPH_MIGRATIONS)
