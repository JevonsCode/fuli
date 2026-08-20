import asyncio
import json

from fastapi import HTTPException

from .collaboration_context import read_collaboration_context
from .graph_models import GraphResult
from .graph_query import read_graph
from .knowledge_search import search_knowledge
from .models import (
    CollaborationContextResult,
    CommitResult,
    KnowledgeCommit,
    SearchRequest,
    SearchResult,
    StructuredEpisode,
)
from .personal_project_access import authorize_personal_project
from .project_agent_access import authorize_project_agent
from .provider_values import now_utc, stable_uuid
from .workflow_candidates import materialize_workflow_candidates


class StoreKnowledge:
    async def commit_personal(self, actor: dict, request: KnowledgeCommit) -> CommitResult:
        self._require_personal()
        space = await self.authorize(actor, request.space_id, 'maintainer')
        if space['kind'] != 'personal':
            raise HTTPException(status_code=422, detail='direct commits are personal-only')
        if request.personal_project_id:
            await authorize_personal_project(
                self, actor, space, request.personal_project_id
            )
        if request.project_agent_id:
            await authorize_project_agent(
                self,
                actor,
                space,
                request.personal_project_id,
                request.project_agent_id,
                require_active=True,
                require_memory=True,
            )
        return await self._commit_episode(
            space,
            request.episode,
            personal_project_id=request.personal_project_id,
            project_agent_id=request.project_agent_id,
        )

    async def commit_workflow_observation(
        self,
        actor: dict,
        request: KnowledgeCommit,
    ) -> CommitResult:
        self._require_personal()
        space = await self.authorize(actor, request.space_id, 'maintainer')
        if space['kind'] != 'personal':
            raise HTTPException(
                status_code=422,
                detail='workflow observations are personal-only',
            )
        if request.personal_project_id:
            await authorize_personal_project(
                self, actor, space, request.personal_project_id
            )
        if request.project_agent_id:
            await authorize_project_agent(
                self,
                actor,
                space,
                request.personal_project_id,
                request.project_agent_id,
                require_active=True,
                require_memory=True,
            )
        return await self._commit_episode(
            space,
            request.episode,
            personal_project_id=request.personal_project_id,
            project_agent_id=request.project_agent_id,
            workflow_session_authority='mcp_host',
        )

    async def search(self, actor: dict, request: SearchRequest) -> SearchResult:
        return await search_knowledge(self, actor, request)

    async def graph(
        self,
        actor: dict,
        space_id: str,
        limit: int | None = None,
        personal_project_id: str | None = None,
        offset: int | None = None,
    ) -> GraphResult:
        return await read_graph(
            self, actor, space_id, limit, personal_project_id, offset
        )

    async def collaboration_context(
        self,
        actor: dict,
        space_id: str,
        personal_project_id: str | None = None,
        limit: int = 100,
        project_agent_id: str | None = None,
    ) -> CollaborationContextResult:
        return await read_collaboration_context(
            self,
            actor,
            space_id,
            personal_project_id,
            limit,
            project_agent_id,
        )

    async def _commit_episode(
        self,
        space: dict,
        episode: StructuredEpisode,
        *,
        personal_project_id: str | None = None,
        project_agent_id: str | None = None,
        workflow_session_authority: str | None = None,
    ) -> CommitResult:
        group_id = space['group_id']
        lock = self._group_locks.setdefault(group_id, asyncio.Lock())
        async with lock:
            episode_id = stable_uuid(group_id, 'episode', episode.idempotency_key)
            existing, _, _ = await self.runtime.driver.execute_query(
                'MATCH (e:Episodic {uuid: $uuid}) RETURN e.uuid AS uuid',
                uuid=episode_id,
                routing_='r',
            )
            entity_ids = [
                _entity_id(
                    group_id,
                    space['kind'],
                    personal_project_id,
                    entity.key,
                    project_agent_id=project_agent_id,
                )
                for entity in episode.entities
            ]
            entity_id_by_key = {
                entity.key: entity_id
                for entity, entity_id in zip(
                    episode.entities, entity_ids, strict=True
                )
            }
            relationship_ids = [
                _relationship_id(
                    group_id,
                    space['kind'],
                    personal_project_id,
                    relationship.key,
                    relationship.fact,
                    (relationship.valid_at or episode.reference_time).isoformat(),
                    project_agent_id=project_agent_id,
                    workflow_session_authority=workflow_session_authority,
                )
                for relationship in episode.relationships
            ]
            entity_input_by_key = {
                entity.key: entity for entity in episode.entities
            }
            workflow_pairs = [
                {
                    'workflow_key': relationship.key,
                    'source_step_id': entity_id_by_key[relationship.source],
                    'source_step_key': relationship.source,
                    'source_step_name': (
                        entity_input_by_key[relationship.source].name
                    ),
                    'target_step_id': entity_id_by_key[relationship.target],
                    'target_step_key': relationship.target,
                    'target_step_name': (
                        entity_input_by_key[relationship.target].name
                    ),
                    'condition_json': _workflow_condition_json(
                        relationship.attributes
                    ),
                }
                for relationship in episode.relationships
                if relationship.type == 'RECOMMENDS_NEXT'
            ]
            if existing:
                await materialize_workflow_candidates(
                    self,
                    space,
                    personal_project_id=personal_project_id,
                    pairs=workflow_pairs,
                )
                return CommitResult(
                    status='duplicate',
                    space_id=space['id'],
                    episode_id=episode_id,
                    entity_ids=entity_ids,
                    relationship_ids=relationship_ids,
                )

            entity_vectors = await self.runtime.embedder.create_batch(
                [entity.name for entity in episode.entities]
            )
            fact_vectors = await self.runtime.embedder.create_batch(
                [relationship.fact for relationship in episode.relationships]
            )
            entity_rows = []
            entity_by_key = {}
            for entity, entity_id, vector in zip(
                episode.entities, entity_ids, entity_vectors, strict=True
            ):
                entity_by_key[entity.key] = entity_id
                entity_rows.append(
                    {
                        'uuid': entity_id,
                        'key': entity.key,
                        'name': entity.name,
                        'type': entity.type,
                        'summary': entity.summary,
                        'origin_quadrant': entity.origin_quadrant,
                        'current_quadrant': entity.current_quadrant,
                        'epistemic_status': entity.epistemic_status,
                        'confirmation_status': entity.confirmation_status,
                        'utility_score': 0.0,
                        'confidence_score': _initial_confidence(
                            entity.confirmation_status
                        ),
                        'confirmation_basis_json': json.dumps(
                            entity.confirmation_basis.model_dump(mode='json'),
                            ensure_ascii=False,
                            sort_keys=True,
                        ),
                        'reasoning_summary': entity.reasoning_summary,
                        'profile_aspect': entity.profile_aspect,
                        'inheritance_mode': entity.inheritance_mode,
                        'inherited_project_ids': entity.inherited_project_ids,
                        'preference_scope': (
                            'agent' if entity.profile_aspect and project_agent_id
                            else 'project' if entity.profile_aspect and personal_project_id
                            else 'global' if entity.profile_aspect else None
                        ),
                        'preference_project_id': (
                            personal_project_id if entity.profile_aspect else None
                        ),
                        'preference_agent_id': (
                            project_agent_id if entity.profile_aspect else None
                        ),
                        'attributes_json': json.dumps(
                            entity.attributes, ensure_ascii=False, sort_keys=True
                        ),
                        'embedding': vector,
                    }
                )
            relationship_rows = []
            superseded_relationships: list[dict[str, str]] = []
            for relationship, relationship_id, vector in zip(
                episode.relationships, relationship_ids, fact_vectors, strict=True
            ):
                superseded_relationships.extend(
                    {
                        'key': superseded_key,
                        'replacement_id': relationship_id,
                    }
                    for superseded_key in relationship.supersedes
                )
                relationship_rows.append(
                    {
                        'uuid': relationship_id,
                        'key': relationship.key,
                        'source_uuid': entity_by_key[relationship.source],
                        'target_uuid': entity_by_key[relationship.target],
                        'name': relationship.type,
                        'fact': relationship.fact,
                        'embedding': vector,
                        'valid_at': relationship.valid_at or episode.reference_time,
                        'invalid_at': relationship.invalid_at,
                        'confidence': relationship.confidence,
                        'origin_quadrant': relationship.origin_quadrant,
                        'current_quadrant': relationship.current_quadrant,
                        'epistemic_status': relationship.epistemic_status,
                        'confirmation_status': relationship.confirmation_status,
                        'utility_score': 0.0,
                        'confidence_score': _initial_confidence(
                            relationship.confirmation_status
                        ),
                        'confirmation_basis_json': json.dumps(
                            relationship.confirmation_basis.model_dump(mode='json'),
                            ensure_ascii=False,
                            sort_keys=True,
                        ),
                        'reasoning_summary': relationship.reasoning_summary,
                        'profile_aspect': relationship.profile_aspect,
                        'inheritance_mode': relationship.inheritance_mode,
                        'inherited_project_ids': relationship.inherited_project_ids,
                        'preference_scope': (
                            'agent' if relationship.profile_aspect and project_agent_id
                            else 'project' if relationship.profile_aspect and personal_project_id
                            else 'global' if relationship.profile_aspect else None
                        ),
                        'preference_project_id': (
                            personal_project_id if relationship.profile_aspect else None
                        ),
                        'preference_agent_id': (
                            project_agent_id if relationship.profile_aspect else None
                        ),
                        'attributes_json': json.dumps(
                            relationship.attributes, ensure_ascii=False, sort_keys=True
                        ),
                        'workflow_condition_json': _workflow_condition_json(
                            relationship.attributes
                        ),
                        'workflow_confirmation_authority': (
                            _workflow_confirmation_authority(relationship)
                        ),
                        'workflow_session_authority': (
                            workflow_session_authority
                        ),
                    }
                )

            created_at = now_utc()
            await self.runtime.driver.execute_query(
                '''
                UNWIND $entities AS row
                MERGE (entity:Entity {uuid: row.uuid})
                ON CREATE SET entity.group_id = $group_id,
                    entity.name = row.name,
                    entity.name_embedding = row.embedding,
                    entity.summary = row.summary,
                    entity.created_at = coalesce(entity.created_at, $created_at),
                    entity.fuli_key = row.key,
                    entity.fuli_type = row.type,
                    entity.fuli_origin_quadrant = coalesce(
                      entity.fuli_origin_quadrant, row.origin_quadrant
                    ),
                    entity.fuli_current_quadrant = row.current_quadrant,
                    entity.fuli_epistemic_status = row.epistemic_status,
                    entity.fuli_confirmation_status = row.confirmation_status,
                    entity.fuli_confirmation_basis_json = row.confirmation_basis_json,
                    entity.fuli_utility_score = coalesce(
                      entity.fuli_utility_score, row.utility_score
                    ),
                    entity.fuli_confidence_score = coalesce(
                      entity.fuli_confidence_score, row.confidence_score
                    ),
                    entity.fuli_qualified_use_count = coalesce(
                      entity.fuli_qualified_use_count, 0
                    ),
                    entity.fuli_distinct_task_count = coalesce(
                      entity.fuli_distinct_task_count, 0
                    ),
                    entity.fuli_usage_generation = coalesce(
                      entity.fuli_usage_generation, 1
                    ),
                    entity.fuli_reasoning_summary = coalesce(
                      row.reasoning_summary, entity.fuli_reasoning_summary
                    ),
                    entity.fuli_profile_aspect = row.profile_aspect,
                    entity.fuli_inheritance_mode = row.inheritance_mode,
                    entity.fuli_inherited_project_ids = row.inherited_project_ids,
                    entity.fuli_preference_scope = row.preference_scope,
                    entity.fuli_preference_project_id = row.preference_project_id,
                    entity.fuli_preference_agent_id = row.preference_agent_id,
                    entity.fuli_attributes_json = row.attributes_json
                WITH count(entity) AS entity_count
                CREATE (episode:Episodic {
                  uuid: $episode_id,
                  group_id: $group_id,
                  name: $episode_name,
                  source: 'json',
                  source_description: $source_description,
                  content: '',
                  valid_at: $reference_time,
                  created_at: $created_at,
                  entity_edges: $relationship_ids,
                  fuli_session_id: $session_id,
                  fuli_source_kind: $source_kind,
                  fuli_source_uri: $source_uri,
                  fuli_source_application: $source_application,
                  fuli_source_turn_id: $source_turn_id,
                  fuli_source_excerpt: $source_excerpt,
                  fuli_summary: $summary,
                  fuli_sensitivity: $sensitivity,
                  fuli_personal_project_id: $personal_project_id,
                  fuli_project_agent_id: $project_agent_id,
                  fuli_idempotency_key: $idempotency_key,
                  fuli_workflow_session_authority:
                    $workflow_session_authority
                })
                WITH episode
                UNWIND $entities AS row
                MATCH (entity:Entity {uuid: row.uuid})
                MERGE (episode)-[mention:MENTIONS {uuid: row.mention_uuid}]->(entity)
                SET mention.group_id = $group_id,
                    mention.created_at = $created_at
                WITH episode
                UNWIND $relationships AS row
                MATCH (source:Entity {uuid: row.source_uuid})
                MATCH (target:Entity {uuid: row.target_uuid})
                MERGE (source)-[edge:RELATES_TO {uuid: row.uuid}]->(target)
                ON CREATE SET edge.group_id = $group_id,
                    edge.name = row.name,
                    edge.fact = row.fact,
                    edge.fact_embedding = row.embedding,
                    edge.episodes = [$episode_id],
                    edge.created_at = $created_at,
                    edge.valid_at = row.valid_at,
                    edge.invalid_at = row.invalid_at,
                    edge.reference_time = $reference_time,
                    edge.fuli_key = row.key,
                    edge.fuli_confidence = row.confidence,
                    edge.fuli_origin_quadrant = row.origin_quadrant,
                    edge.fuli_current_quadrant = row.current_quadrant,
                    edge.fuli_epistemic_status = row.epistemic_status,
                    edge.fuli_confirmation_status = row.confirmation_status,
                    edge.fuli_confirmation_basis_json = row.confirmation_basis_json,
                    edge.fuli_utility_score = row.utility_score,
                    edge.fuli_confidence_score = row.confidence_score,
                    edge.fuli_qualified_use_count = 0,
                    edge.fuli_distinct_task_count = 0,
                    edge.fuli_usage_generation = 1,
                    edge.fuli_reasoning_summary = row.reasoning_summary,
                    edge.fuli_profile_aspect = row.profile_aspect,
                    edge.fuli_inheritance_mode = row.inheritance_mode,
                    edge.fuli_inherited_project_ids = row.inherited_project_ids,
                    edge.fuli_preference_scope = row.preference_scope,
                    edge.fuli_preference_project_id = row.preference_project_id,
                    edge.fuli_preference_agent_id = row.preference_agent_id,
                    edge.fuli_attributes_json = row.attributes_json,
                    edge.fuli_workflow_condition_json =
                      row.workflow_condition_json,
                    edge.fuli_workflow_confirmation_authority =
                      row.workflow_confirmation_authority,
                    edge.fuli_workflow_session_authority =
                      row.workflow_session_authority
                SET edge.episodes =
                  CASE WHEN $episode_id IN coalesce(edge.episodes, [])
                       THEN edge.episodes
                       ELSE coalesce(edge.episodes, []) + $episode_id END
                WITH count(edge) AS edge_count
                OPTIONAL MATCH ()-[old:RELATES_TO {group_id: $group_id}]->()
                WHERE old.invalid_at IS NULL
                  AND NOT (old.uuid IN $relationship_ids)
                  AND (
                    EXISTS {
                      MATCH (:FuliSpace {id: $space_id})-
                            [:HAS_KNOWLEDGE_ASSIGNMENT]->
                            (assignment:FuliKnowledgeAssignment {
                              item_kind: 'relationship',
                              item_id: old.uuid
                            })
                      WHERE assignment.project_id = $personal_project_id
                    }
                    OR (
                      NOT EXISTS {
                        MATCH (:FuliSpace {id: $space_id})-
                              [:HAS_KNOWLEDGE_ASSIGNMENT]->
                              (:FuliKnowledgeAssignment {
                                item_kind: 'relationship',
                                item_id: old.uuid
                              })
                      }
                      AND EXISTS {
                        MATCH (old_episode:Episodic {group_id: $group_id})
                        WHERE old_episode.uuid IN coalesce(old.episodes, [])
                          AND (
                            old_episode.fuli_personal_project_id =
                              $personal_project_id
                            OR (
                              old_episode.fuli_personal_project_id IS NULL
                              AND $personal_project_id IS NULL
                            )
                          )
                      }
                    )
                  )
                  AND EXISTS {
                    MATCH (agent_episode:Episodic {group_id: $group_id})
                    WHERE agent_episode.uuid IN coalesce(old.episodes, [])
                      AND (
                        agent_episode.fuli_project_agent_id = $project_agent_id
                        OR (
                          agent_episode.fuli_project_agent_id IS NULL
                          AND $project_agent_id IS NULL
                        )
                      )
                  }
                  AND any(
                    replacement IN $superseded_relationships
                    WHERE replacement.key = old.fuli_key
                  )
                WITH edge_count, old, head([
                  replacement IN $superseded_relationships
                  WHERE replacement.key = old.fuli_key | replacement
                ]) AS replacement
                FOREACH (_ IN CASE WHEN old IS NULL THEN [] ELSE [1] END |
                  SET old.invalid_at = $reference_time,
                      old.expired_at = $created_at,
                      old.fuli_replaced_by_item_id = replacement.replacement_id,
                      old.fuli_replaced_by_item_kind = 'relationship'
                )
                RETURN edge_count
                ''',
                entities=[
                    {
                        **row,
                        'mention_uuid': stable_uuid(episode_id, 'mentions', row['uuid']),
                    }
                    for row in entity_rows
                ],
                relationships=relationship_rows,
                superseded_relationships=superseded_relationships,
                space_id=space['id'],
                group_id=group_id,
                episode_id=episode_id,
                episode_name=episode.name,
                source_description=episode.source_description,
                reference_time=episode.reference_time,
                created_at=created_at,
                relationship_ids=relationship_ids,
                session_id=episode.session_id,
                source_kind=episode.source_kind,
                source_uri=episode.source_uri,
                source_application=episode.source_application,
                source_turn_id=episode.source_turn_id,
                source_excerpt=episode.source_excerpt,
                summary=episode.summary,
                sensitivity=episode.sensitivity,
                personal_project_id=personal_project_id,
                project_agent_id=project_agent_id,
                workflow_session_authority=workflow_session_authority,
                idempotency_key=episode.idempotency_key,
            )
            await materialize_workflow_candidates(
                self,
                space,
                personal_project_id=personal_project_id,
                pairs=workflow_pairs,
            )
            return CommitResult(
                status='committed',
                space_id=space['id'],
                episode_id=episode_id,
                entity_ids=entity_ids,
                relationship_ids=relationship_ids,
            )


def _initial_confidence(status: str) -> float:
    return {
        'pending': 0.5,
        'agent_confirmed': 0.75,
        'confirmed': 1.0,
    }[status]


def _workflow_condition_json(attributes: dict) -> str:
    condition = attributes.get(
        'workflowCondition',
        attributes.get('workflow_condition', {}),
    )
    if not isinstance(condition, dict):
        condition = {}
    return json.dumps(condition, ensure_ascii=False, sort_keys=True)


def _workflow_confirmation_authority(relationship) -> str:
    basis = relationship.confirmation_basis
    if relationship.confirmation_status == 'confirmed' and basis.confirmed_by:
        return basis.confirmed_by.kind
    return {
        'agent': 'agent_proposed',
        'import': 'import_proposed',
        'user': 'user',
        'authoritative_source': 'authoritative_source',
    }[basis.proposed_by.kind]


def _entity_id(
    group_id: str,
    space_kind: str,
    personal_project_id: str | None,
    key: str,
    *,
    project_agent_id: str | None = None,
) -> str:
    if space_kind == 'personal' and personal_project_id:
        parts = [group_id, 'entity', 'personal-project', personal_project_id]
        if project_agent_id:
            parts.extend(['project-agent', project_agent_id])
        return stable_uuid(*parts, key)
    return stable_uuid(group_id, 'entity', key)


def _relationship_id(
    group_id: str,
    space_kind: str,
    personal_project_id: str | None,
    key: str,
    fact: str,
    reference_time: str,
    *,
    project_agent_id: str | None = None,
    workflow_session_authority: str | None = None,
) -> str:
    parts = [group_id, 'relationship']
    if space_kind == 'personal' and personal_project_id:
        parts.extend(['personal-project', personal_project_id])
        if project_agent_id:
            parts.extend(['project-agent', project_agent_id])
    if workflow_session_authority:
        parts.extend([
            'workflow-session-authority',
            workflow_session_authority,
        ])
    return stable_uuid(*parts, key, fact, reference_time)
