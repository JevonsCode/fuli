"""Graph migrations that change existing records (rec#17 D-09).

These ran on every provider start before the format registry. They are never
automatic now: each one counts the records it would still change, a store
where that count is zero has them in effect already (baseline detection), and
any other count leaves the graph read-only until a person confirms the
migration. The apply functions are the confirmed step's bodies.
"""

from .store_project_agent_executor_learning import (
    project_agent_executor_outcome_bucket_id,
)

_BUCKET_PROPERTIES = (
    'personal_space_id',
    'personal_project_id',
    'work_kind',
    'agent_id',
    'executor_id',
    'model_strategy_key',
)
# label, bucket kind, newest-first property, public ID property
_BUCKET_LABELS = (
    ('FuliProjectAgentExecutorOutcomeAggregate', 'aggregate', 'bucket.as_of', 'aggregate_id'),
    ('FuliProjectAgentExecutorOutcomeReset', 'reset', 'bucket.reset_at', 'reset_id'),
)


async def _count(driver, query: str) -> int:
    records, _, _ = await driver.execute_query(query, routing_='r')
    return int(records[0]['pending']) if records else 0


async def _learning_buckets(driver, label: str):
    projections = ', '.join(f'bucket.{name} AS {name}' for name in _BUCKET_PROPERTIES)
    completeness = ' AND '.join(f'bucket.{name} IS NOT NULL' for name in _BUCKET_PROPERTIES)
    records, _, _ = await driver.execute_query(
        f'''
        MATCH (bucket:{label})
        WHERE {completeness}
        WITH {projections}, collect(bucket.id) AS ids, count(bucket) AS nodes
        RETURN {', '.join(_BUCKET_PROPERTIES)}, ids, nodes
        ''',
        routing_='r',
    )
    return records


def _bucket_id(settings, bucket: dict, bucket_kind: str) -> str:
    return project_agent_executor_outcome_bucket_id(
        settings.provider_id,
        bucket['personal_space_id'],
        bucket['personal_project_id'],
        bucket['work_kind'],
        bucket['agent_id'],
        bucket['executor_id'],
        bucket['model_strategy_key'],
        bucket_kind=bucket_kind,
    )


async def pending_learning_bucket_ids(driver, settings) -> int:
    pending = 0
    for label, bucket_kind, _, _ in _BUCKET_LABELS:
        for record in await _learning_buckets(driver, label):
            bucket = {name: str(record[name]) for name in _BUCKET_PROPERTIES}
            expected = _bucket_id(settings, bucket, bucket_kind)
            if record['nodes'] != 1 or record['ids'] != [expected]:
                pending += 1
    return pending


async def apply_learning_bucket_ids(driver, settings) -> None:
    """Give legacy learning caches stable IDs and collapse duplicates.

    Aggregates and resets are replaceable projections. For each complete
    provider/space bucket the newest projection is kept and only older
    projection nodes are removed; immutable outcome evidence is untouched.
    """
    property_match = ', '.join(f'{name}: ${name}' for name in _BUCKET_PROPERTIES)
    for label, bucket_kind, latest_property, public_id_property in _BUCKET_LABELS:
        for record in await _learning_buckets(driver, label):
            bucket = {name: str(record[name]) for name in _BUCKET_PROPERTIES}
            await driver.execute_query(
                f'''
                MATCH (bucket:{label} {{{property_match}}})
                WITH bucket
                ORDER BY coalesce(
                  {latest_property},
                  bucket.updated_at,
                  bucket.created_at,
                  datetime({{epochMillis: 0}})
                ) DESC, elementId(bucket) DESC
                WITH collect(bucket) AS buckets
                WITH head(buckets) AS keeper, tail(buckets) AS duplicates
                CALL {{
                  WITH duplicates
                  UNWIND duplicates AS duplicate
                  DETACH DELETE duplicate
                  RETURN count(*) AS removed_count
                }}
                SET keeper.id = $bucket_id,
                    keeper.{public_id_property} = $bucket_id
                RETURN removed_count
                ''',
                **bucket,
                bucket_id=_bucket_id(settings, bucket, bucket_kind),
            )


_LEGACY_AGENTS = '''
MATCH (space:FuliSpace {kind: 'personal'})-[:CONTAINS_PROJECT]->
      (project:FuliPersonalProject)-[:HAS_PROJECT_AGENT]->
      (agent:FuliProjectAgent)
'''


async def pending_legacy_agent_assignments(driver, _settings) -> int:
    return await _count(
        driver,
        _LEGACY_AGENTS + '''
        WHERE agent.agent_id IS NULL OR agent.agent_type IS NULL
           OR agent.memory_scope IS NULL OR agent.status IS NULL
           OR NOT (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(agent)
           OR NOT EXISTS {
             MATCH (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->
                   (assignment:FuliProjectAgentAssignment)-[:ASSIGNED_AGENT]->(agent)
             WHERE assignment.id = agent.id + ':legacy-assignment:' + project.id
           }
        RETURN count(*) AS pending
        ''',
    )


async def apply_legacy_agent_assignments(driver, _settings) -> None:
    """Preserve legacy project-bound Agents while adding space identities.

    Agents are not merged by name and no knowledge namespace is rewritten;
    only explicit assignment history is created.
    """
    await driver.execute_query(
        _LEGACY_AGENTS + '''
        MERGE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(agent)
        SET agent.agent_id = coalesce(agent.agent_id, agent.id),
            agent.agent_type = coalesce(agent.agent_type, 'durable'),
            agent.memory_scope = coalesce(agent.memory_scope, 'reviewed_agent'),
            agent.status = coalesce(agent.status, 'active')
        WITH project, agent,
             agent.id + ':legacy-assignment:' + project.id AS assignment_id
        MERGE (assignment:FuliProjectAgentAssignment {id: assignment_id})
        ON CREATE SET assignment.assignment_id = assignment_id,
                      assignment.responsibility =
                        coalesce(agent.responsibility, agent.name),
                      assignment.work_kinds =
                        coalesce(agent.work_kinds, []),
                      assignment.capabilities =
                        coalesce(agent.capabilities, []),
                      assignment.reason = 'legacy Project Agent migration',
                      assignment.status = CASE agent.status
                        WHEN 'active' THEN 'active' ELSE 'ended' END,
                      assignment.revision = 0,
                      assignment.assigned_at = agent.created_at,
                      assignment.updated_at =
                        coalesce(agent.updated_at, agent.created_at),
                      assignment.legacy_assignment = true
        MERGE (project)-[:HAS_PROJECT_AGENT_ASSIGNMENT]->(assignment)
        MERGE (assignment)-[:ASSIGNED_AGENT]->(agent)
        '''
    )


_LIFECYCLE_MISSING = '''
WHERE item.fuli_utility_score IS NULL
   OR item.fuli_confidence_score IS NULL
   OR item.fuli_qualified_use_count IS NULL
   OR item.fuli_distinct_task_count IS NULL
   OR item.fuli_usage_generation IS NULL
   OR item.fuli_inheritance_mode IS NULL
   OR item.fuli_inherited_project_ids IS NULL
'''
_LIFECYCLE_DEFAULTS = '''
SET item.fuli_ai_review_lock_version =
      coalesce(item.fuli_ai_review_lock_version, 0) + 1
SET item.fuli_utility_score =
      coalesce(item.fuli_utility_score, 0.0),
    item.fuli_confidence_score = coalesce(
      item.fuli_confidence_score,
      CASE coalesce(item.fuli_confirmation_status, 'pending')
        WHEN 'confirmed' THEN 1.0
        WHEN 'agent_confirmed' THEN 0.75
        ELSE 0.5
      END
    ),
    item.fuli_qualified_use_count =
      coalesce(item.fuli_qualified_use_count, 0),
    item.fuli_distinct_task_count =
      coalesce(item.fuli_distinct_task_count, 0),
    item.fuli_usage_generation =
      coalesce(item.fuli_usage_generation, 1),
    item.fuli_inheritance_mode =
      coalesce(item.fuli_inheritance_mode, 'local_only'),
    item.fuli_inherited_project_ids =
      coalesce(item.fuli_inherited_project_ids, [])
'''


async def pending_knowledge_lifecycle_defaults(driver, _settings) -> int:
    nodes = await _count(
        driver, 'MATCH (item:Entity)' + _LIFECYCLE_MISSING + 'RETURN count(item) AS pending'
    )
    relationships = await _count(
        driver,
        'MATCH ()-[item:RELATES_TO]->()' + _LIFECYCLE_MISSING + 'RETURN count(item) AS pending',
    )
    return nodes + relationships


async def apply_knowledge_lifecycle_defaults(driver, _settings) -> None:
    await driver.execute_query(
        'MATCH (item:Entity)' + _LIFECYCLE_MISSING
        + "WITH item ORDER BY 'entity:' + item.uuid" + _LIFECYCLE_DEFAULTS
    )
    await driver.execute_query(
        'MATCH ()-[item:RELATES_TO]->()' + _LIFECYCLE_MISSING
        + "WITH item ORDER BY 'relationship:' + item.uuid" + _LIFECYCLE_DEFAULTS
    )


async def pending_project_relation_review_defaults(driver, _settings) -> int:
    # Only relations the defaults would change: a pending relation already
    # has no confirmation authority by design.
    return await _count(
        driver,
        '''
        MATCH ()-[relation:PERSONAL_PROJECT_RELATION]->()
        WHERE relation.status IS NULL
           OR relation.decision_revision IS NULL
           OR (relation.confirmation_authority IS NULL
               AND NOT relation.status IN ['active', 'rejected', 'pending'])
        RETURN count(relation) AS pending
        ''',
    )


async def apply_project_relation_review_defaults(driver, _settings) -> None:
    await driver.execute_query(
        '''
        MATCH ()-[relation:PERSONAL_PROJECT_RELATION]->()
        WHERE relation.status IS NULL
           OR relation.decision_revision IS NULL
           OR relation.confirmation_authority IS NULL
        SET relation.status = CASE
              WHEN relation.status IN ['active', 'rejected']
                THEN relation.status
              ELSE 'pending'
            END,
            relation.decision_revision =
              coalesce(relation.decision_revision, 0),
            relation.confirmation_authority = CASE
              WHEN relation.status = 'active'
                AND relation.confirmation_authority = 'human_review'
                THEN 'human_review'
              ELSE null
            END
        '''
    )


_UNOWNED_PROJECT_SPACES = '''
MATCH (space:FuliSpace {kind: 'project'})
WHERE NOT EXISTS {
  MATCH (:FuliPrincipal)-[:OWNS]->(space)
}
OPTIONAL MATCH (principal:FuliPrincipal)-[membership:MEMBER_OF]->(space)
WHERE membership.role = 'maintainer'
WITH space, principal, membership
ORDER BY coalesce(membership.created_at, space.created_at)
WITH space, head(collect(principal.id)) AS owner_id
WHERE owner_id IS NOT NULL
'''


async def pending_space_visibility_and_owners(driver, _settings) -> int:
    hidden = await _count(
        driver, 'MATCH (s:FuliSpace) WHERE s.visibility IS NULL RETURN count(s) AS pending'
    )
    unowned = await _count(driver, _UNOWNED_PROJECT_SPACES + 'RETURN count(space) AS pending')
    return hidden + unowned


async def apply_space_visibility_and_owners(driver, _settings) -> None:
    await driver.execute_query(
        "MATCH (s:FuliSpace) WHERE s.visibility IS NULL "
        "SET s.visibility = CASE s.kind WHEN 'project' THEN 'public' ELSE 'private' END"
    )
    records, _, _ = await driver.execute_query(
        _UNOWNED_PROJECT_SPACES + 'RETURN space.id AS space_id, owner_id',
        routing_='r',
    )
    for record in records:
        await driver.execute_query(
            '''
            MATCH (principal:FuliPrincipal {id: $owner_id})
            MATCH (space:FuliSpace {id: $space_id})
            MERGE (principal)-[:OWNS]->(space)
            ''',
            owner_id=record['owner_id'],
            space_id=record['space_id'],
        )


_UNRELEASED_PUBLIC_PROJECTS = '''
MATCH (owner:FuliPrincipal)-[:OWNS]->
      (space:FuliSpace {kind: 'project', visibility: 'public'})
WHERE space.release_version IS NULL
'''


async def pending_project_release_records(driver, _settings) -> int:
    return await _count(driver, _UNRELEASED_PUBLIC_PROJECTS + 'RETURN count(space) AS pending')


async def apply_project_release_records(driver, _settings) -> None:
    await driver.execute_query(
        _UNRELEASED_PUBLIC_PROJECTS + '''
        WITH owner, space, 'legacy-release-' + space.id AS release_id
        SET space.release_version = 'legacy',
            space.release_id = release_id,
            space.release_summary = '历史项目迁移，原始版本与更新内容未记录',
            space.release_publisher_id = owner.id,
            space.release_publisher_name = owner.name,
            space.released_at = space.created_at,
            space.updated_at = coalesce(space.updated_at, space.created_at)
        MERGE (release:FuliProjectRelease {id: release_id})
        ON CREATE SET release.project_id = space.id,
                      release.version = 'legacy',
                      release.summary = '历史项目迁移，原始版本与更新内容未记录',
                      release.publisher_id = owner.id,
                      release.publisher_name = owner.name,
                      release.published_at = space.created_at
        MERGE (space)-[:HAS_RELEASE]->(release)
        '''
    )


async def pending_group_id_separators(driver, _settings) -> int:
    return await _count(
        driver, "MATCH (s:FuliSpace) WHERE s.group_id CONTAINS ':' RETURN count(s) AS pending"
    )


async def apply_group_id_separators(driver, _settings) -> None:
    """One transaction per space renames its Graphiti group everywhere."""
    records, _, _ = await driver.execute_query(
        "MATCH (s:FuliSpace) WHERE s.group_id CONTAINS ':' "
        'RETURN s.id AS id, s.group_id AS group_id',
        routing_='r',
    )
    for record in records:
        previous = record['group_id']
        current = previous.replace(':', '-')
        async with driver.transaction() as transaction:
            await transaction.run(
                'MATCH (s:FuliSpace {id: $space_id}) SET s.group_id = $current',
                space_id=record['id'],
                current=current,
            )
            await transaction.run(
                'MATCH (n) WHERE n.group_id = $previous SET n.group_id = $current',
                previous=previous,
                current=current,
            )
            await transaction.run(
                'MATCH ()-[r]->() WHERE r.group_id = $previous SET r.group_id = $current',
                previous=previous,
                current=current,
            )
