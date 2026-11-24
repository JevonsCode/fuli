"""The scope classifier's table covers the whole graph, and its edge cases
(docs/runner-roles-design.md, "Scopes in the graph") hold on a synthetic
in-memory graph. The same rules on a real Neo4j: test_scope_export_neo4j.py."""
import re

from fuli_graph.conversation_scope import conversation_scope_id
from fuli_graph.graph_field_contract import NODE_FIELDS, RELATIONSHIP_FIELDS
from fuli_graph.graph_format_journal import UNDO_LABEL
from fuli_graph.graph_format_migrations import GRAPH_MIGRATIONS
from fuli_graph.scope_classifier import (
    DERIVED, GLOBAL, LOCAL_ONLY, NODE_RULES, RELATIONSHIP_RULES, GraphNode, GraphRelationship,
    ScopeClassification, conversation_scopes, exported,
)
from fuli_graph.scope_export import SpaceRead, _left_out
from test_graph_field_contract import NODE, PACKAGE, RELATIONSHIP, provider_texts

JUDGES = {'fixed', 'projects', 'parent', 'item', 'items', 'knowledge', 'evidence', 'project', 'conversation',
          'relation', 'space'}


def written_labels_and_types():
    """Every node label and relationship type the provider can find in the
    graph: each one a Cypher string literal of the provider names in a node
    pattern `(x:Label …)` or a relationship pattern `[x:TYPE …]`, each one the
    field contract declares, and each one a graph format version declares
    (labels retired from the code stay declared there, and stay in old graphs)."""
    labels, types = set(NODE_FIELDS), set(RELATIONSHIP_FIELDS)
    for _, text in provider_texts():
        for match in NODE.finditer(text):
            labels |= set(re.findall(r'[A-Za-z_]\w*', match.group(2)))
        for match in RELATIONSHIP.finditer(text):
            types |= set(re.findall(r'[A-Z_][A-Z0-9_]*', match.group(2)))
    for migration in GRAPH_MIGRATIONS:
        labels |= migration.labels
    return labels | {UNDO_LABEL}, types


def test_every_label_and_relationship_type_has_a_scope_rule():
    labels, types = written_labels_and_types()
    assert sorted(labels - set(NODE_RULES)) == [], 'Classify these labels in scope_classifier.NODE_RULES'
    assert sorted(types - set(RELATIONSHIP_RULES)) == [], 'Classify these types in RELATIONSHIP_RULES'
    # A row the provider no longer writes is dead data.
    assert sorted(set(NODE_RULES) - labels) == []
    assert sorted(set(RELATIONSHIP_RULES) - types) == []


def test_the_design_names_every_label_and_relationship_type():
    design = (PACKAGE.parents[1] / 'docs' / 'runner-roles-design.md').read_text(encoding='utf-8')
    section = design[design.index('## 12. Scopes in the graph'):]
    missing = sorted(name for name in [*NODE_RULES, *RELATIONSHIP_RULES] if f'`{name}`' not in section)
    assert missing == [], 'Name these in docs/runner-roles-design.md, "Scopes in the graph"'


def test_every_rule_is_well_formed_and_names_its_evidence():
    for label, rule in NODE_RULES.items():
        kind = rule.judge[0]
        assert kind in JUDGES, label
        assert rule.key, label
        never_exported = rule.judge in (('fixed', LOCAL_ONLY), ('fixed', DERIVED))
        assert exported(rule) is not never_exported or kind == 'space', label
        if rule.found and rule.found[0] == 'child':
            assert exported(NODE_RULES[rule.found[2]]) or rule.found[2] == 'FuliSpace', label
        if kind == 'parent':
            assert rule.found[0] == 'child', label
        assert (PACKAGE / rule.evidence.split()[0].rstrip(',')).exists(), label
    for kind, (rule, evidence) in RELATIONSHIP_RULES.items():
        assert rule in {'endpoints', 'item', LOCAL_ONLY}, kind
        assert (PACKAGE / evidence.split()[0].rstrip(',')).exists(), kind


class Graph:
    """A synthetic personal space, built as the reader in scope_export.py builds one."""

    def __init__(self):
        self.space = 'element-space'
        self.nodes, self.relationships = {}, []

    def node(self, label, parent=None, **properties):
        element = f'element-{len(self.nodes)}'
        self.nodes[element] = GraphNode(element, label, (label,), properties)
        if parent:
            self.nodes[element].parents.add(parent)
        return element

    def link(self, start, kind, end, **properties):
        self.relationships.append(GraphRelationship(f'rel-{len(self.relationships)}', kind, start, end, properties))

    def classify(self, conversations=None):
        return ScopeClassification(self.space, self.nodes, self.relationships, conversations or {})


def preference(graph, uuid, **scope):
    return graph.node('Entity', uuid=uuid, group_id='synthetic-group', fuli_profile_aspect='taste', **scope)


def project(graph, project_id):
    element = graph.node('FuliPersonalProject', id=f'node-{project_id}', project_id=project_id)
    graph.link(graph.space, 'CONTAINS_PROJECT', element)
    return element


def test_preferences_belong_to_every_project_they_name_and_inherit():
    graph = Graph()
    for name in ('alpha', 'beta', 'gamma'):
        project(graph, name)
    habit = preference(graph, 'habit-global')
    both = preference(graph, 'habit-both', fuli_preference_scope='project', fuli_preference_project_id='alpha',
                      fuli_preference_project_ids=['alpha', 'beta'])
    inherited = preference(graph, 'habit-inherited', fuli_preference_scope='project',
                           fuli_preference_project_id='alpha', fuli_inheritance_mode='selected_projects',
                           fuli_inherited_project_ids=['gamma'])
    descendants = preference(graph, 'habit-descendants', fuli_preference_scope='project',
                             fuli_preference_project_id='alpha', fuli_inheritance_mode='descendants')
    agent = preference(graph, 'habit-agent', fuli_preference_scope='agent', fuli_preference_project_id='beta',
                       fuli_preference_agent_id='synthetic-agent')
    scopes = graph.classify().node_scopes
    assert scopes(habit) == {GLOBAL}
    assert scopes(both) == {'project:alpha', 'project:beta'}
    assert scopes(inherited) == {'project:alpha', 'project:gamma'}
    assert scopes(descendants) == {'project:alpha'}
    assert scopes(agent) == {'project:beta'}


def test_knowledge_follows_its_assignment_sources_and_active_references():
    graph = Graph()
    for name in ('alpha', 'beta', 'gamma'):
        project(graph, name)
    assigned = graph.node('Entity', uuid='fact-assigned')
    graph.node('FuliKnowledgeAssignment', id='a1', item_kind='entity', item_id='fact-assigned', project_id='alpha')
    graph.node('FuliKnowledgeProjectReference', id='r1', item_kind='entity', item_id='fact-assigned',
               project_id='beta', status='active')
    graph.node('FuliKnowledgeProjectReference', id='r2', item_kind='entity', item_id='fact-assigned',
               project_id='gamma', status='rejected')
    sourced = graph.node('Entity', uuid='fact-sourced')
    episode = graph.node('Episodic', uuid='episode-gamma', fuli_personal_project_id='gamma')
    graph.link(episode, 'MENTIONS', sourced)
    unscoped = graph.node('Entity', uuid='fact-unscoped')
    revision = graph.node('FuliKnowledgeRevision', id='v1', item_kind='entity', item_id='fact-assigned')
    orphan = graph.node('FuliKnowledgeRevision', id='v2', item_kind='entity', item_id='fact-hard-deleted')
    scopes = graph.classify().node_scopes
    assert scopes(assigned) == {'project:alpha', 'project:beta'}
    assert scopes(sourced) == {'project:gamma'}
    assert scopes(unscoped) == {GLOBAL}
    assert scopes(revision) == scopes(assigned)
    assert scopes(orphan) == {GLOBAL}


def test_a_fact_takes_its_entities_and_its_evidence_with_it():
    graph = Graph()
    project(graph, 'alpha')
    source, target = graph.node('Entity', uuid='rust'), graph.node('Entity', uuid='safety')
    graph.node('FuliKnowledgeAssignment', id='a1', item_kind='relationship', item_id='fact', project_id='alpha')
    graph.link(source, 'RELATES_TO', target, uuid='fact', episodes=['episode'])
    habit = preference(graph, 'habit-global')
    episode = graph.node('Episodic', uuid='episode', entity_edges=['fact'])
    graph.link(episode, 'MENTIONS', habit)
    classification = graph.classify()
    fact, mention = (next(item for item in classification.relationships if item.type == kind)
                     for kind in ('RELATES_TO', 'MENTIONS'))
    assert classification.relationship_scopes(fact) == {'project:alpha'}
    assert classification.node_scopes(source) == classification.node_scopes(target) == {'project:alpha'}
    # One episode, evidence for a global habit and a project fact: both scopes keep it.
    assert classification.node_scopes(episode) == {GLOBAL, 'project:alpha'}
    assert classification.relationship_scopes(mention) == {GLOBAL, 'project:alpha'}


def test_cross_scope_records_belong_to_their_project_end():
    graph = Graph()
    alpha_project = project(graph, 'alpha')
    agent = graph.node('FuliProjectAgent', id='fla', agent_id='fla')
    graph.link(graph.space, 'HAS_PROJECT_AGENT_IDENTITY', agent)
    assignment = graph.node('FuliProjectAgentAssignment', parent=alpha_project, id='assignment')
    graph.link(assignment, 'ASSIGNED_AGENT', agent)
    global_memory = graph.node('FuliProjectAgentMemory', id='memory-global', agent_id='fla')
    project_memory = graph.node('FuliProjectAgentMemory', id='memory-alpha', agent_id='fla',
                                personal_project_id='alpha')
    checkpoint = graph.node('FuliProjectAgentMemoryCheckpoint', parent=project_memory, id='checkpoint')
    graph.link(agent, 'HAS_WORKING_MEMORY', global_memory)
    graph.link(agent, 'HAS_WORKING_MEMORY', project_memory)
    habit = preference(graph, 'habit-global')
    local = preference(graph, 'habit-alpha', fuli_preference_scope='project', fuli_preference_project_id='alpha')
    conflict = graph.node('FuliPreferenceConflict', id='conflict', left_item_kind='entity', left_item_id='habit-global',
                          right_item_kind='entity', right_item_id='habit-alpha')
    session = 'element-session-never-read'
    context = graph.node('FuliTaskContext', id='context', personal_project_id='alpha')
    graph.link(session, 'HAS_CONTEXT', context)
    classification = graph.classify()
    by_end = {(relationship.start, relationship.end): relationship for relationship in classification.relationships}
    assert classification.node_scopes(agent) == classification.node_scopes(global_memory) == {GLOBAL}
    assert classification.node_scopes(assignment) == classification.node_scopes(checkpoint) == {'project:alpha'}
    assert classification.relationship_scopes(by_end[(assignment, agent)]) == {'project:alpha'}
    assert classification.relationship_scopes(by_end[(agent, global_memory)]) == {GLOBAL}
    assert classification.relationship_scopes(by_end[(agent, project_memory)]) == {'project:alpha'}
    assert classification.node_scopes(conflict) == {'project:alpha'}
    assert classification.references[conflict] == {habit, local}
    # A session is this computer's: what hangs from it is exported, the link is not.
    assert classification.node_scopes(context) == {'project:alpha'}
    assert classification.relationship_scopes(by_end[(session, context)]) == frozenset()


def test_conversations_are_found_by_journal_scope_and_unknown_journals_stay_here():
    graph = Graph()
    project(graph, 'alpha')
    journals = conversation_scopes('space', ['fla'], ['alpha'])
    alpha_journal = next(scope for scope, project_id in journals.items() if project_id == 'alpha')
    global_journal = next(scope for scope, project_id in journals.items() if project_id is None)
    in_alpha = graph.node('FuliConversation', id='c1', scope=alpha_journal)
    event = graph.node('FuliConversationEvent', parent=in_alpha, id='e1')
    in_global = graph.node('FuliConversation', id='c2', scope=global_journal)
    unknown = graph.node('FuliConversation', id='c3', scope='journal-of-no-agent')
    scopes = graph.classify(journals).node_scopes
    assert scopes(in_alpha) == scopes(event) == {'project:alpha'}
    assert scopes(in_global) == {GLOBAL}
    assert scopes(unknown) == {LOCAL_ONLY}


def test_what_an_export_leaves_out_is_counted_by_label():
    graph = Graph()
    project(graph, 'alpha')
    journals = conversation_scopes('space', ['fla'], ['alpha'])
    # A journal whose project has no node: its scope cannot be told.
    unknown = graph.node('FuliConversation', id='c1', scope=conversation_scope_id('space', 'gone', 'fla'))
    graph.node('FuliConversationEvent', parent=unknown, id='e1')
    unread = {'element-session': ('FuliTaskContextSession',), 'element-old': ('OldLabel', 'OtherOldLabel'),
              'element-aggregate': ('FuliProjectAgentExecutorOutcomeAggregate',)}
    read = SpaceRead(graph.classify(journals), unread, {'CONTAINS_PROJECT'})
    unclassified, local_only = _left_out(read)
    assert unclassified == {'OldLabel': 1, 'OtherOldLabel': 1}
    assert local_only == {'FuliConversation': 1, 'FuliConversationEvent': 1, 'FuliTaskContextSession': 1}


def test_a_record_of_projects_the_space_no_longer_has_stays_with_the_person():
    graph = Graph()
    project(graph, 'alpha')
    gone = graph.node('FuliTaskContext', id='context', personal_project_id='deleted-project')
    assert graph.classify().node_scopes(gone) == {GLOBAL, 'project:deleted-project'}


def test_the_space_is_in_every_scope_and_an_unclassified_type_is_never_exported():
    graph = Graph()
    alpha = project(graph, 'alpha')
    graph.link(alpha, 'A_TYPE_NO_RULE_NAMES', alpha)
    classification = graph.classify()
    contains, unknown = classification.relationships
    assert classification.relationship_scopes(contains) == {'project:alpha'}
    assert classification.relationship_scopes(unknown) == frozenset()
