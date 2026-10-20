"""Whether the constraints and indexes in Neo4j mean what the format declares
(rec#17 D-09).

A rule counts as present only when an object of that name has the declared
kind, type, entity, label or relationship type and properties, and has not
failed. A same-named object that means something else - a plain index posing
as a uniqueness constraint, other properties, another label - is a mismatch,
never 'already in effect'.
"""

from dataclasses import dataclass
import re

_CONSTRAINT = re.compile(
    r'^CREATE CONSTRAINT (?P<name>\w+) IF NOT EXISTS FOR \(\w+:(?P<target>\w+)\) '
    r'REQUIRE \(?(?P<properties>[^)]*?)\)? IS UNIQUE$'
)
_INDEX = re.compile(
    r'^CREATE (?:(?P<fulltext>FULLTEXT) )?INDEX (?P<name>\w+) IF NOT EXISTS FOR '
    r'(?:\(\w+:(?P<node>\w+)\)|\(\)-\[\w+:(?P<relationship>\w+)\]-\(\)) '
    r'ON (?:EACH \[(?P<each>[^\]]*)\]|\((?P<properties>[^)]*)\))$'
)
_FAILED = 'FAILED'


@dataclass(frozen=True)
class RuleShape:
    kind: str  # 'constraint' or 'index'
    type: str  # 'UNIQUENESS', 'RANGE' or 'FULLTEXT'
    entity: str  # 'NODE' or 'RELATIONSHIP'
    target: tuple[str, ...]
    properties: tuple[str, ...]


def _properties(text: str) -> tuple[str, ...]:
    return tuple(item.strip().split('.', 1)[1] for item in text.split(','))


def declared_shape(cypher: str) -> RuleShape:
    """The shape a declared CREATE statement gives its rule."""
    if match := _CONSTRAINT.match(cypher):
        return RuleShape('constraint', 'UNIQUENESS', 'NODE', (match['target'],),
                         _properties(match['properties']))
    if match := _INDEX.match(cypher):
        node = match['node']
        return RuleShape(
            'index', 'FULLTEXT' if match['fulltext'] else 'RANGE',
            'NODE' if node else 'RELATIONSHIP', (node or match['relationship'],),
            _properties(match['each'] or match['properties']),
        )
    raise ValueError(f'unrecognised schema rule: {cypher}')


async def existing_rules(driver) -> dict[str, tuple[RuleShape, str]]:
    """Every constraint and standalone index by name, with its state."""
    constraints, _, _ = await driver.execute_query(
        'SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties',
        routing_='r',
    )
    indexes, _, _ = await driver.execute_query(
        'SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, state, '
        'owningConstraint',
        routing_='r',
    )
    states = {record['name']: record['state'] for record in indexes}
    found = {}
    for record in constraints:
        found[record['name']] = (_shape('constraint', record), states.get(record['name'], 'ONLINE'))
    for record in indexes:
        if record['owningConstraint'] or record['type'] == 'LOOKUP':
            continue
        found[record['name']] = (_shape('index', record), record['state'])
    return found


def _shape(kind: str, record) -> RuleShape:
    return RuleShape(kind, record['type'], record['entityType'],
                     tuple(record['labelsOrTypes'] or ()), tuple(record['properties'] or ()))


def compare_rules(rules, existing) -> tuple[list, list[str]]:
    """The declared rules that are missing, and how present ones differ."""
    missing, mismatched = [], []
    for rule in rules:
        if rule.name not in existing:
            missing.append(rule)
            continue
        shape, state = existing[rule.name]
        expected = declared_shape(rule.cypher)
        if shape != expected:
            mismatched.append(
                f'{rule.name} is a {shape.kind} {shape.type} on {shape.entity} '
                f'{"|".join(shape.target)}({", ".join(shape.properties)}), declared as a '
                f'{expected.kind} {expected.type} on {expected.entity} '
                f'{"|".join(expected.target)}({", ".join(expected.properties)})'
            )
        elif state == _FAILED:
            mismatched.append(f'{rule.name} exists but its index failed')
    return missing, mismatched
