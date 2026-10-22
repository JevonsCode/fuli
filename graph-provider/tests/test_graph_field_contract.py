"""The persisted-field contract (rec#30) against the provider's own code:
every property its Cypher names is declared for its label, every declared
property is still named somewhere, every map write goes through the
contract, and every enum value the Cypher or a model names is registered.
The per-version record of the contract is checked in test_graph_format.py."""

import ast
import re
import typing
from collections import defaultdict
from pathlib import Path

import pytest

from fuli_graph import (
    graph_format_ledger,
    graph_format_migrations,
    knowledge_review_models,
    knowledge_tag_governance_models,
    knowledge_tag_models,
    models,
    project_action_models,
    project_agent_attention_models,
    project_agent_executor_models,
    project_agent_models,
    project_agent_task_models,
    workflow_candidate_models,
)
from fuli_graph.graph_field_contract import (
    ENUMS,
    NODE_FIELDS,
    RELATIONSHIP_FIELDS,
    StoredFieldError,
    stored_fields,
)
from fuli_graph.graph_format_journal import CREATED_TAG, UNDO_LABEL
from fuli_graph.graph_format_migrations import GRAPH_MIGRATIONS
from fuli_graph.store_knowledge_tags import Neo4jLockedTagVocabulary

PACKAGE = Path(__file__).resolve().parents[1] / 'fuli_graph'
FIELDS = {**NODE_FIELDS, **RELATIONSHIP_FIELDS}
CYPHER = re.compile(r'\b(MATCH|MERGE|CREATE|SET|RETURN|WHERE)\b')
NODE = re.compile(r'\(\s*([a-z_]\w*)?\s*((?::\s*[A-Za-z_]\w*)+)\s*(\{)?')
RELATIONSHIP = re.compile(r'\[\s*([a-z_]\w*)?\s*:\s*([A-Z_][A-Z0-9_]*(?:\s*\|\s*:?[A-Z_][A-Z0-9_]*)*)\s*(\{)?')
LITERAL_MAP = re.compile(r'(?<![\w$.])([a-z_]\w*)\s*\+?=\s*(?:[a-z_]\w*\s*)?\{')
ASSIGNED = re.compile(r'(?<![\w$.])([a-z_]\w*)\.([a-z][A-Za-z0-9_]*)\s*=(?!=)')
COMPARED = re.compile(r"(?<![\w$.])([a-z_]\w*)\.([a-z]\w*)\s*(?:=|<>|IN)\s*(\[[^\]]*\]|'[^']*')"
                      r"|coalesce\(\s*([a-z_]\w*)\.([a-z]\w*)\s*,\s*('[^']*')")
STRING = re.compile(r"'([^']+)'")
# Where a SET clause ends: the next clause, or the end of a FOREACH body.
CLAUSE_END = re.compile(r'\b(?:SET|MATCH|MERGE|CREATE|WITH|RETURN|REMOVE|DELETE|DETACH|FOREACH|UNWIND|CALL|'
                        r'WHERE|UNION|ORDER|LIMIT)\b|\)')


def provider_texts():
    """(module, text) for every string literal of the provider that reads like Cypher."""
    for path in sorted(PACKAGE.glob('*.py')):
        for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and CYPHER.search(node.value):
                yield path.name, node.value


def _map_items(text, start):
    """(key, value text) of the map whose '{' ends at text[start]."""
    depth, items, token, index = 1, [], start, start
    while index < len(text) and depth:
        char = text[index]
        if char in '{[(':
            depth += 1
        elif char in '}])':
            depth -= 1
        elif char == "'":
            end = text.find("'", index + 1)
            index = end if end >= 0 else len(text)
        if (depth == 1 and char == ',') or depth == 0:
            key, colon, value = text[token:index].partition(':')
            if colon and re.fullmatch(r'\s*[a-z]\w*\s*', key):
                items.append((key.strip(), value.strip()))
            token = index + 1
        index += 1
    return items


def cypher_properties():
    """(module, owners, property, value text) for each property the Cypher
    names: a key of a pattern's map or of a literal map set on a record, or a
    property set or compared (n.p = …) on a variable the same text binds to a
    label or type, with its literal value text where there is one."""
    for module, text in provider_texts():
        bound = defaultdict(set)
        for pattern, names in ((NODE, r'[A-Za-z_]\w*'), (RELATIONSHIP, r'[A-Z_][A-Z0-9_]*')):
            for match in pattern.finditer(text):
                owners = set(re.findall(names, match.group(2)))
                if match.group(1):
                    bound[match.group(1)] |= owners
                if match.group(3):
                    for key, value in _map_items(text, match.end()):
                        yield module, frozenset(owners), key, value
        for match in LITERAL_MAP.finditer(text):
            for key, value in _map_items(text, match.end()):
                yield module, frozenset(bound.get(match.group(1), ())), key, value
        for variable, name in ASSIGNED.findall(text):
            yield module, frozenset(bound.get(variable, ())), name, None
        for match in COMPARED.finditer(text):
            variable, name, value = match.group(1, 2, 3) if match.group(1) else match.group(4, 5, 6)
            if variable in bound:
                yield module, frozenset(bound[variable]), name, value


def _declared(owners, name):
    known = [owner for owner in owners if owner in FIELDS]
    return any(name in FIELDS[owner] for owner in known) if known else any(
        name in fields for fields in FIELDS.values())


def test_every_property_the_cypher_names_is_declared_for_its_label():
    undeclared = sorted({
        f'{module}: {"|".join(sorted(owners)) or "?"}.{name}'
        for module, owners, name, _ in cypher_properties()
        if name != CREATED_TAG and not _declared(owners, name)
    })
    assert undeclared == [], 'Declare these in graph_field_contract.py with the next graph version'
    owners = {owner for _, named, name, _ in cypher_properties() if name != CREATED_TAG for owner in named}
    assert sorted(owners - set(FIELDS)) == [], 'Declare the label or type in graph_field_contract.py'


def test_every_declared_property_is_still_named_by_the_provider():
    words = set()
    for path in PACKAGE.glob('*.py'):
        if path.name != 'graph_field_contract.py':
            words |= set(re.findall(r'\w+', path.read_text(encoding='utf-8')))
    # The undo journal keeps each journaled property's earlier value as b_<property>.
    journaled = {f'b_{name}' for migration in GRAPH_MIGRATIONS if migration.journal
                 for touch in migration.journal.touches for name in touch.properties}
    unused = sorted(f'{owner}.{name}' for owner, fields in FIELDS.items() for name in fields
                    if name not in words and name not in journaled)
    assert unused == [], 'No code names these any more: remove them with the next graph version'
    assert sorted({name for name in FIELDS[UNDO_LABEL] if name.startswith('b_')} ^ journaled) == []


# Every write that hands Neo4j a whole map, by module, record variable and
# operator. Its keys are invisible to the checks above, so the map is built
# through stored_fields. knowledge_versions' `reference = old {.*, …}` copies a
# stored record of the same label and adds only the keys it names.
MAP_WRITES = {
    ('knowledge_versions.py', 'item', '='),
    ('knowledge_versions.py', 'link', '+='),
    ('store_conversation_triage.py', 't', '+='),
    ('store_knowledge_tags.py', 'tag', '='),
    ('store_knowledge_tags.py', 'tag', '+='),
    ('store_knowledge_tags.py', 'revision', '='),
    ('store_occupation_catalog.py', 'occupation', '+='),
    ('store_occupation_catalog.py', 'occupation', '='),
    ('store_project_agent_attention.py', 'request', '+='),
    ('store_project_agent_task_recruitment.py', 'recruitment', '+='),
    ('store_project_agent_worker_runs.py', 'run', '+='),
    ('system_hr_identity.py', 'edge', '='),
}
CYPHER_COPY = ('knowledge_versions.py', 'reference', '=')


def map_writes():
    """(module, variable, operator) of each SET item that sets a whole record
    from a map other than a literal one (whose keys the checks above see)."""
    for module, text in provider_texts():
        for clause in re.finditer(r'\bSET\b', text):
            end = CLAUSE_END.search(text, clause.end())
            for item in re.split(r',(?![^{\[(]*[}\])])', text[clause.end():end.start() if end else None]):
                match = re.match(r'\s*([a-z_]\w*)\s*(\+?=)(?!=)(?!\s*\{)', item)
                if match:
                    yield module, match.group(1), match.group(2)


def test_every_map_write_goes_through_the_contract():
    assert sorted(set(map_writes()) ^ MAP_WRITES ^ {CYPHER_COPY}) == [], (
        'A new map write builds its map with stored_fields and is listed in MAP_WRITES'
    )
    for module in {module for module, _, _ in MAP_WRITES}:
        assert 'from .graph_field_contract import stored_fields' in (
            PACKAGE / module).read_text(encoding='utf-8'), module


def test_an_unknown_or_mistyped_map_key_is_refused():
    with pytest.raises(StoredFieldError, match='undeclared properties nickname'):
        stored_fields('FuliKnowledgeTag', {'name': 'Rust', 'nickname': 'rs'})
    with pytest.raises(StoredFieldError, match='FuliKnowledgeTag.alias_keys must be string'):
        stored_fields('FuliKnowledgeTag', {'alias_keys': 'rust'})
    with pytest.raises(StoredFieldError, match='FuliKnowledgeTag.status may not be null'):
        stored_fields('FuliKnowledgeTag', {'status': None})
    with pytest.raises(StoredFieldError, match='FuliKnowledgeTag.status must be tag_status'):
        stored_fields('FuliKnowledgeTag', {'status': 'archived'})
    assert stored_fields('FuliKnowledgeTag', {'merged_into_id': None}) == {'merged_into_id': None}


class RecordingDriver:
    def __init__(self):
        self.queries = []

    async def execute_query(self, query, **parameters):
        self.queries.append(query)
        return [], None, None


async def test_a_tag_write_with_an_unknown_key_writes_nothing():
    driver = RecordingDriver()
    vocabulary = Neo4jLockedTagVocabulary(driver, 'synthetic-space')

    with pytest.raises(StoredFieldError, match='undeclared properties synonym_keys'):
        await vocabulary.apply(updates=[{'id': 'synthetic-tag', 'at': None, 'fields': {'synonym_keys': []}}])
    with pytest.raises(StoredFieldError, match='undeclared properties nickname'):
        await vocabulary.apply(revisions=[{'id': 'synthetic-revision', 'nickname': 'rs'}])
    assert driver.queries == []


def _enum(declared: str):
    kind = declared.rstrip('?').removesuffix('[]')
    return kind if kind in ENUMS else None


def test_every_enum_is_used():
    used = {_enum(declared) for fields in FIELDS.values() for declared in fields.values()}
    assert sorted(set(ENUMS) - used) == []
    assert all(len(set(values)) == len(values) for values in ENUMS.values())


def test_every_enum_value_the_cypher_names_is_registered():
    unregistered = sorted({
        f'{module}: {owner}.{name} = {value!r}'
        for module, owners, name, text in cypher_properties() if text
        for owner in owners if owner in FIELDS and name in FIELDS[owner]
        for value in STRING.findall(text)
        if (enum := _enum(FIELDS[owner][name])) and value not in ENUMS[enum]
    })
    assert unregistered == [], (
        'A new enum value is a format change: register it in ENUMS with the next graph version'
    )


# Where each enum's values are defined in the code: a value added there must
# be registered in ENUMS too.
ENUM_SOURCES = {
    'assignment_status': project_agent_models.ProjectAgentAssignmentStatus,
    'attention_status': project_agent_attention_models.AttentionStatus,
    'confirmation_mode': project_agent_task_models.ProjectAgentRecruitmentConfirmationMode,
    'confirmation_status': models.ConfirmationStatus,
    'content_source': models.ContentSource,
    'epistemic_status': models.EpistemicStatus,
    'executor_evidence_kind': project_agent_executor_models.ProjectAgentExecutorEvidenceKind,
    'executor_evidence_source': project_agent_executor_models.ProjectAgentExecutorEvidenceSource,
    'executor_fallback_outcome': project_agent_executor_models.ProjectAgentExecutorFallbackOutcome,
    'executor_health_status': project_agent_executor_models.ProjectAgentExecutorHealthStatus,
    'executor_permission_status': project_agent_executor_models.ProjectAgentExecutorPermissionStatus,
    'executor_preflight_status': project_agent_executor_models.ProjectAgentExecutorPreflightStatus,
    'executor_registration_status': project_agent_executor_models.ProjectAgentExecutorRegistrationStatus,
    'executor_scope': project_agent_executor_models.ProjectAgentExecutorScope,
    'executor_selection_status': project_agent_executor_models.ProjectAgentExecutorSelectionStatus,
    'executor_terminal_outcome': project_agent_executor_models.ProjectAgentExecutorTerminalOutcome,
    'feedback_kind': models.KnowledgeFeedbackKind,
    'human_change_status': models.HumanChangeStatus,
    'inheritance_mode': models.KnowledgeInheritanceMode,
    'item_kind': models.KnowledgeItemKind,
    'knowledge_audit_action': models.KnowledgeAuditAction,
    'knowledge_revision_action': models.KnowledgeRevisionAction,
    'ledger_status': graph_format_ledger.STATUSES,
    'memory_scope': project_agent_models.ProjectAgentMemoryScope,
    'migration_kind': graph_format_migrations.AUTOMATIC_KINDS | graph_format_migrations.RECORD_KINDS,
    'operation_actor': models.KnowledgeOperationActor,
    'participant_role': project_agent_task_models.ProjectAgentParticipantRole,
    'position_kind': project_agent_task_models.ProjectAgentPositionKind,
    'preference_conflict_status': models.PreferenceConflictQueueStatus,
    'preference_scope': models.ScopedPreferenceScope,
    'profile_aspect': models.PersonalProfileAspect,
    'project_agent_status': project_agent_models.ProjectAgentStatus,
    'project_agent_type': project_agent_models.ProjectAgentType,
    'project_reference_status': project_action_models.KnowledgeProjectReferenceStatus,
    'project_relation_status': models.ProjectRelationStatus,
    'project_relation_type': models.ProjectRelationType,
    'quadrant': models.EpistemicQuadrant,
    'recruitment_status': project_agent_task_models.ProjectAgentRecruitmentStatus,
    'review_run_status': knowledge_review_models.KnowledgeReviewStatus,
    'routing_outcome': project_agent_task_models.ProjectAgentRoutingOutcome,
    'routing_rule_status': project_agent_executor_models.ProjectAgentExecutorRuleStatus,
    'sensitivity': models.Sensitivity,
    'space_kind': models.SpaceKind,
    'space_visibility': models.SpaceVisibility,
    'staffing_intent': project_agent_task_models.ProjectAgentStaffingIntent,
    'tag_namespace': knowledge_tag_models.StoredTagNamespace,
    'tag_relation': knowledge_tag_governance_models.TagRelationKind,
    'tag_status': knowledge_tag_models.TagStatus,
    'task_status': project_agent_task_models.ProjectAgentTaskStatus,
    'workflow_candidate_status': workflow_candidate_models.WorkflowCandidateStatus,
    'workflow_confirmation_authority': workflow_candidate_models.WorkflowConfirmationAuthority,
}


def test_every_enum_value_the_code_defines_is_registered():
    unregistered = sorted(f'{enum}: {value!r}' for enum, source in ENUM_SOURCES.items()
                          for value in (typing.get_args(source) or source) if value not in ENUMS[enum])
    assert unregistered == [], (
        'A new enum value is a format change: register it in ENUMS with the next graph version'
    )
