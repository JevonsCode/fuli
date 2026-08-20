import hashlib
import math
import os
import re
import unicodedata
from collections.abc import Iterable
from typing import Any

os.environ.setdefault('GRAPHITI_TELEMETRY_ENABLED', 'false')

from graphiti_core import Graphiti
from graphiti_core.cross_encoder.client import CrossEncoderClient
from graphiti_core.driver.neo4j_driver import Neo4jDriver
from graphiti_core.embedder.client import EmbedderClient
from graphiti_core.llm_client.client import LLMClient
from graphiti_core.llm_client.config import LLMConfig, ModelSize
from graphiti_core.prompts.models import Message
from pydantic import BaseModel

from .config import Settings
from .store_project_agent_executor_learning import (
    project_agent_executor_outcome_bucket_id,
)


class AgentStructuredLLM(LLMClient):
    """Guardrail that prevents the provider from sending knowledge to another LLM."""

    def __init__(self):
        super().__init__(
            LLMConfig(
                api_key='disabled',
                model='agent-structured-input',
                small_model='agent-structured-input',
                max_tokens=1,
            )
        )

    async def _generate_response(
        self,
        messages: list[Message],
        response_model: type[BaseModel] | None = None,
        max_tokens: int = 1,
        model_size: ModelSize = ModelSize.medium,
    ) -> dict[str, Any]:
        del messages, response_model, max_tokens, model_size
        raise RuntimeError(
            'This Fuli provider accepts agent-structured graph input and never invokes a second LLM'
        )


class LocalHashEmbedder(EmbedderClient):
    """Small deterministic multilingual embedder with no model or network dependency."""

    def __init__(self, dimensions: int):
        if dimensions < 64:
            raise ValueError('Local hash embeddings require at least 64 dimensions')
        self.dimensions = dimensions

    async def create(
        self,
        input_data: str | list[str] | Iterable[int] | Iterable[Iterable[int]],
    ) -> list[float]:
        text = input_data if isinstance(input_data, str) else ' '.join(map(str, input_data))
        return self._embed(text)

    async def create_batch(self, input_data_list: list[str]) -> list[list[float]]:
        return [self._embed(value) for value in input_data_list]

    def _embed(self, value: str) -> list[float]:
        normalized = unicodedata.normalize('NFKC', value).casefold()
        compact = ''.join(character for character in normalized if not character.isspace())
        features = re.findall(r'[\w.-]+', normalized, flags=re.UNICODE)
        features.extend(compact[index : index + 2] for index in range(max(len(compact) - 1, 0)))
        features.extend(compact[index : index + 3] for index in range(max(len(compact) - 2, 0)))
        vector = [0.0] * self.dimensions
        for feature in features:
            if not feature:
                continue
            digest = hashlib.blake2b(
                feature.encode('utf-8'),
                digest_size=8,
                person=b'fuli-embed-v1',
            ).digest()
            bucket = int.from_bytes(digest[:4], 'big') % self.dimensions
            vector[bucket] += 1.0 if digest[4] & 1 else -1.0
        magnitude = math.sqrt(sum(value * value for value in vector))
        return vector if magnitude == 0 else [value / magnitude for value in vector]


class LocalLexicalReranker(CrossEncoderClient):
    async def rank(self, query: str, passages: list[str]) -> list[tuple[str, float]]:
        query_terms = set(query.casefold().split())

        def score(passage: str) -> float:
            normalized = passage.casefold()
            if query.casefold() in normalized:
                return 1.0
            if not query_terms:
                return 0.0
            matches = sum(term in normalized for term in query_terms)
            return matches / len(query_terms)

        return sorted(
            [(passage, score(passage)) for passage in passages],
            key=lambda item: item[1],
            reverse=True,
        )


class GraphitiRuntime:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.embedder = LocalHashEmbedder(settings.embedding_dim)
        driver = Neo4jDriver(
            uri=settings.neo4j_uri,
            user=settings.neo4j_user,
            password=settings.neo4j_password,
            database=settings.neo4j_database,
        )
        self.graphiti = Graphiti(
            graph_driver=driver,
            llm_client=AgentStructuredLLM(),
            embedder=self.embedder,
            cross_encoder=LocalLexicalReranker(),
            store_raw_episode_content=False,
        )

    @property
    def driver(self):
        return self.graphiti.driver

    async def initialize(self) -> None:
        await self.graphiti.build_indices_and_constraints()
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_principal_id IF NOT EXISTS '
            'FOR (n:FuliPrincipal) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_space_id IF NOT EXISTS '
            'FOR (n:FuliSpace) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_subscription_id IF NOT EXISTS '
            'FOR (n:FuliSubscription) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_proposal_id IF NOT EXISTS '
            'FOR (n:FuliProposal) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_personal_project_id IF NOT EXISTS '
            'FOR (n:FuliPersonalProject) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_publication_draft_id IF NOT EXISTS '
            'FOR (n:FuliPublicationDraft) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_project_release_id IF NOT EXISTS '
            'FOR (n:FuliProjectRelease) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_knowledge_reference_id IF NOT EXISTS '
            'FOR (n:FuliKnowledgeProjectReference) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_knowledge_conflict_id IF NOT EXISTS '
            'FOR (n:FuliKnowledgeConflict) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_knowledge_audit_id IF NOT EXISTS '
            'FOR (n:FuliKnowledgeAudit) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_knowledge_review_id IF NOT EXISTS '
            'FOR (n:FuliKnowledgeReviewRun) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_knowledge_review_active IF NOT EXISTS '
            'FOR (n:FuliKnowledgeReviewRun) REQUIRE n.active_key IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_knowledge_review_decision_id IF NOT EXISTS '
            'FOR (n:FuliKnowledgeReviewDecision) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_workflow_candidate_id IF NOT EXISTS '
            'FOR (n:FuliWorkflowCandidate) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_workflow_review_event_id IF NOT EXISTS '
            'FOR (n:FuliWorkflowReviewEvent) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_workflow_review_preview_id IF NOT EXISTS '
            'FOR (n:FuliWorkflowReviewPreview) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_workflow_review_preview_token IF NOT EXISTS '
            'FOR (n:FuliWorkflowReviewPreview) REQUIRE n.token_hash IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_workflow_rule_id IF NOT EXISTS '
            'FOR (n:FuliWorkflowRule) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_workflow_authorization_id IF NOT EXISTS '
            'FOR (n:FuliWorkflowAuthorization) REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_personal_global_preference_decision '
            'IF NOT EXISTS '
            'FOR (n:FuliPersonalGlobalPreferenceDecision) '
            'REQUIRE (n.space_id, n.candidate_id) IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_personal_global_preference_event '
            'IF NOT EXISTS '
            'FOR (n:FuliPersonalGlobalPreferenceDecisionEvent) '
            'REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_personal_global_preference_preview '
            'IF NOT EXISTS '
            'FOR (n:FuliPersonalGlobalPreferenceDecisionPreview) '
            'REQUIRE n.id IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_personal_global_preference_preview_token '
            'IF NOT EXISTS '
            'FOR (n:FuliPersonalGlobalPreferenceDecisionPreview) '
            'REQUIRE n.token_hash IS UNIQUE'
        )
        await self.driver.execute_query(
            'CREATE CONSTRAINT fuli_personal_project_relation_review '
            'IF NOT EXISTS '
            'FOR (n:FuliPersonalProjectRelationReview) '
            'REQUIRE n.id IS UNIQUE'
        )
        # Legacy learning caches were keyed only by a composite property map.
        # Collapse those buckets before adding ID uniqueness so startup remains
        # safe for upgraded stores as well as fresh databases.
        await self._migrate_project_agent_executor_learning_buckets()
        for query in (
            'CREATE CONSTRAINT fuli_project_agent_id IF NOT EXISTS '
            'FOR (n:FuliProjectAgent) REQUIRE n.id IS UNIQUE',
            'CREATE CONSTRAINT fuli_project_agent_assignment_id IF NOT EXISTS '
            'FOR (n:FuliProjectAgentAssignment) REQUIRE n.id IS UNIQUE',
            'CREATE CONSTRAINT fuli_project_agent_task_id IF NOT EXISTS '
            'FOR (n:FuliProjectAgentTask) REQUIRE n.id IS UNIQUE',
            'CREATE CONSTRAINT fuli_project_agent_task_event_id IF NOT EXISTS '
            'FOR (n:FuliProjectAgentTaskEvent) REQUIRE n.id IS UNIQUE',
            'CREATE CONSTRAINT fuli_project_agent_routing_decision_id IF NOT EXISTS '
            'FOR (n:FuliProjectAgentRoutingDecision) REQUIRE n.id IS UNIQUE',
            'CREATE CONSTRAINT fuli_project_agent_recruitment_id IF NOT EXISTS '
            'FOR (n:FuliProjectAgentRecruitment) REQUIRE n.id IS UNIQUE',
            'CREATE CONSTRAINT fuli_project_agent_recruitment_policy_space '
            'IF NOT EXISTS FOR (n:FuliProjectAgentRecruitmentPolicy) '
            'REQUIRE n.personal_space_id IS UNIQUE',
            'CREATE CONSTRAINT fuli_project_agent_executor_id IF NOT EXISTS '
            'FOR (n:FuliProjectAgentExecutor) REQUIRE n.id IS UNIQUE',
            'CREATE CONSTRAINT fuli_project_agent_executor_routing_rule_id IF NOT EXISTS '
            'FOR (n:FuliProjectAgentExecutorRoutingRule) REQUIRE n.id IS UNIQUE',
            'CREATE CONSTRAINT fuli_project_agent_executor_decision_id IF NOT EXISTS '
            'FOR (n:FuliProjectAgentExecutorDecision) REQUIRE n.id IS UNIQUE',
            'CREATE CONSTRAINT fuli_project_agent_executor_outcome_evidence_id IF NOT EXISTS '
            'FOR (n:FuliProjectAgentExecutorOutcomeEvidence) REQUIRE n.id IS UNIQUE',
            'CREATE CONSTRAINT fuli_project_agent_executor_outcome_aggregate_id IF NOT EXISTS '
            'FOR (n:FuliProjectAgentExecutorOutcomeAggregate) REQUIRE n.id IS UNIQUE',
            'CREATE CONSTRAINT fuli_project_agent_executor_outcome_reset_id IF NOT EXISTS '
            'FOR (n:FuliProjectAgentExecutorOutcomeReset) REQUIRE n.id IS UNIQUE',
            'CREATE CONSTRAINT fuli_project_agent_executor_observation_id IF NOT EXISTS '
            'FOR (n:FuliProjectAgentExecutorObservation) REQUIRE n.id IS UNIQUE',
        ):
            await self.driver.execute_query(query)
        for query in (
            'CREATE INDEX fuli_entity_confirmation IF NOT EXISTS '
            'FOR (n:Entity) ON (n.group_id, n.fuli_confirmation_status)',
            'CREATE INDEX fuli_entity_usage_score IF NOT EXISTS '
            'FOR (n:Entity) ON (n.group_id, n.fuli_utility_score)',
            'CREATE INDEX fuli_relationship_confirmation IF NOT EXISTS '
            'FOR ()-[r:RELATES_TO]-() '
            'ON (r.group_id, r.fuli_confirmation_status)',
            'CREATE INDEX fuli_relationship_usage_score IF NOT EXISTS '
            'FOR ()-[r:RELATES_TO]-() ON (r.group_id, r.fuli_utility_score)',
            'CREATE INDEX fuli_knowledge_assignment_lookup IF NOT EXISTS '
            'FOR (n:FuliKnowledgeAssignment) '
            'ON (n.space_id, n.item_kind, n.item_id)',
            'CREATE INDEX fuli_knowledge_reference_lookup IF NOT EXISTS '
            'FOR (n:FuliKnowledgeProjectReference) '
            'ON (n.space_id, n.item_kind, n.item_id)',
            'CREATE INDEX fuli_knowledge_audit_lookup IF NOT EXISTS '
            'FOR (n:FuliKnowledgeAudit) '
            'ON (n.space_id, n.item_id, n.usage_generation)',
            'CREATE INDEX fuli_knowledge_review_scope IF NOT EXISTS '
            'FOR (n:FuliKnowledgeReviewRun) '
            'ON (n.personal_space_id, n.scope_key, n.status)',
            'CREATE INDEX fuli_personal_project_relation_type IF NOT EXISTS '
            'FOR ()-[r:PERSONAL_PROJECT_RELATION]-() ON (r.relation_type)',
            'CREATE INDEX fuli_project_agent_assignment_lookup IF NOT EXISTS '
            'FOR (n:FuliProjectAgentAssignment) '
            'ON (n.status, n.assigned_at)',
            'CREATE INDEX fuli_project_agent_task_lookup IF NOT EXISTS '
            'FOR (n:FuliProjectAgentTask) '
            'ON (n.personal_space_id, n.personal_project_id, n.status)',
            'CREATE INDEX fuli_project_agent_event_activity IF NOT EXISTS '
            'FOR (n:FuliProjectAgentTaskEvent) '
            'ON (n.agent_id, n.activity_date, n.status)',
            'CREATE INDEX fuli_project_agent_executor_eligibility IF NOT EXISTS '
            'FOR (n:FuliProjectAgentExecutor) '
            'ON (n.personal_space_id, n.registration_status, n.preflight_status, n.health_status)',
            'CREATE INDEX fuli_project_agent_executor_rule_scope IF NOT EXISTS '
            'FOR (n:FuliProjectAgentExecutorRoutingRule) '
            'ON (n.personal_space_id, n.scope, n.personal_project_id, n.task_id)',
            'CREATE INDEX fuli_project_agent_executor_evidence_lookup IF NOT EXISTS '
            'FOR (n:FuliProjectAgentExecutorOutcomeEvidence) '
            'ON (n.personal_space_id, n.agent_id, n.work_kind, n.executor_id, n.occurred_at)',
            'CREATE INDEX fuli_project_agent_aggregate_lookup IF NOT EXISTS '
            'FOR (n:FuliProjectAgentExecutorOutcomeAggregate) '
            'ON (n.personal_space_id, n.personal_project_id, n.agent_id, '
            'n.work_kind, n.executor_id, n.model_strategy_key)',
        ):
            await self.driver.execute_query(query)
        await self._migrate_project_agent_control_plane()
        await self._migrate_knowledge_lifecycle_defaults()
        await self._migrate_personal_project_relation_review_defaults()
        await self._migrate_space_visibility_and_owners()
        await self._migrate_project_releases()
        await self._migrate_legacy_group_ids()

    async def _migrate_project_agent_executor_learning_buckets(self) -> None:
        """Give legacy learning caches stable IDs and collapse duplicates.

        Aggregates and resets are replaceable projections.  For each complete
        provider/space bucket we keep the newest projection, remove only older
        projection nodes, and leave immutable outcome evidence untouched.
        """

        bucket_properties = (
            'personal_space_id',
            'personal_project_id',
            'work_kind',
            'agent_id',
            'executor_id',
            'model_strategy_key',
        )
        migrations = (
            (
                'FuliProjectAgentExecutorOutcomeAggregate',
                'aggregate',
                'bucket.as_of',
                'aggregate_id',
            ),
            (
                'FuliProjectAgentExecutorOutcomeReset',
                'reset',
                'bucket.reset_at',
                'reset_id',
            ),
        )
        for label, bucket_kind, latest_property, public_id_property in migrations:
            projections = ', '.join(
                f'bucket.{property_name} AS {property_name}'
                for property_name in bucket_properties
            )
            completeness = ' AND '.join(
                f'bucket.{property_name} IS NOT NULL'
                for property_name in bucket_properties
            )
            records, _, _ = await self.driver.execute_query(
                f'''
                MATCH (bucket:{label})
                WHERE {completeness}
                RETURN DISTINCT {projections}
                ''',
                routing_='r',
            )
            for record in records:
                bucket = {
                    property_name: str(record[property_name])
                    for property_name in bucket_properties
                }
                bucket_id = project_agent_executor_outcome_bucket_id(
                    self.settings.provider_id,
                    bucket['personal_space_id'],
                    bucket['personal_project_id'],
                    bucket['work_kind'],
                    bucket['agent_id'],
                    bucket['executor_id'],
                    bucket['model_strategy_key'],
                    bucket_kind=bucket_kind,
                )
                property_match = ', '.join(
                    f'{property_name}: ${property_name}'
                    for property_name in bucket_properties
                )
                await self.driver.execute_query(
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
                    bucket_id=bucket_id,
                )

    async def _migrate_project_agent_control_plane(self) -> None:
        """Preserve legacy project-bound records while adding space identities.

        The migration does not merge Agents by name or rewrite any existing
        knowledge namespace. It only creates explicit assignment history and
        the one system coordinator required by the lightweight control plane.
        """
        await self.driver.execute_query(
            '''
            MATCH (space:FuliSpace {kind: 'personal'})-[:CONTAINS_PROJECT]->
                  (project:FuliPersonalProject)-[:HAS_PROJECT_AGENT]->
                  (agent:FuliProjectAgent)
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
        await self.driver.execute_query(
            '''
            MATCH (space:FuliSpace {kind: 'personal'})
            MERGE (policy:FuliProjectAgentRecruitmentPolicy {
              personal_space_id: space.id
            })
            ON CREATE SET policy.confirmation_mode = 'automatic',
                          policy.updated_at = datetime()
            MERGE (space)-[:HAS_PROJECT_AGENT_RECRUITMENT_POLICY]->(policy)
            '''
        )
        records, _, _ = await self.driver.execute_query(
            "MATCH (space:FuliSpace {kind: 'personal'}) RETURN space.id AS space_id",
            routing_='r',
        )
        if not records:
            return
        from .project_agent_models import ProjectAgentProfile
        from .provider_values import now_utc, stable_uuid

        profile = ProjectAgentProfile(
            name='项目协调人',
            responsibility='评估任务、应用用户配置并路由已有 Agent。',
            agent_type='coordinator',
            work_kinds=['task-coordination'],
            capabilities=['任务评估', '策略应用', 'Agent 路由'],
            initial_preferences=['质量与可验收完成优先于成本和时间'],
            status='active',
        )
        updated_at = now_utc()
        for record in records:
            space_id = record['space_id']
            node_id = stable_uuid(
                self.settings.provider_id,
                space_id,
                'project-agent',
                'fuli-project-coordinator',
            )
            await self.driver.execute_query(
                '''
                MATCH (space:FuliSpace {id: $space_id, kind: 'personal'})
                MERGE (agent:FuliProjectAgent {id: $id})
                ON CREATE SET agent.agent_id = 'fuli-project-coordinator',
                              agent.profile_json = $profile_json,
                              agent.name = $name,
                              agent.responsibility = $responsibility,
                              agent.capabilities = $capabilities,
                              agent.work_kinds = $work_kinds,
                              agent.agent_type = 'coordinator',
                              agent.memory_scope = 'reviewed_agent',
                              agent.status = 'active',
                              agent.system_managed = true,
                              agent.created_at = $updated_at,
                              agent.updated_at = $updated_at
                MERGE (space)-[:HAS_PROJECT_AGENT_IDENTITY]->(agent)
                ''',
                space_id=space_id,
                id=node_id,
                profile_json=profile.model_dump_json(),
                name=profile.name,
                responsibility=profile.responsibility,
                capabilities=profile.capabilities,
                work_kinds=profile.work_kinds,
                updated_at=updated_at,
            )

    async def _migrate_personal_project_relation_review_defaults(self) -> None:
        await self.driver.execute_query(
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

    async def _migrate_space_visibility_and_owners(self) -> None:
        await self.driver.execute_query(
            "MATCH (s:FuliSpace) WHERE s.visibility IS NULL "
            "SET s.visibility = CASE s.kind WHEN 'project' THEN 'public' ELSE 'private' END"
        )
        records, _, _ = await self.driver.execute_query(
            '''
            MATCH (space:FuliSpace {kind: 'project'})
            WHERE NOT EXISTS {
              MATCH (:FuliPrincipal)-[:OWNS]->(space)
            }
            OPTIONAL MATCH (principal:FuliPrincipal)-[membership:MEMBER_OF]->(space)
            WHERE membership.role = 'maintainer'
            WITH space, principal, membership
            ORDER BY coalesce(membership.created_at, space.created_at)
            RETURN space.id AS space_id, head(collect(principal.id)) AS owner_id
            ''',
            routing_='r',
        )
        for record in records:
            if not record['owner_id']:
                continue
            await self.driver.execute_query(
                '''
                MATCH (principal:FuliPrincipal {id: $owner_id})
                MATCH (space:FuliSpace {id: $space_id})
                MERGE (principal)-[:OWNS]->(space)
                ''',
                owner_id=record['owner_id'],
                space_id=record['space_id'],
            )

    async def _migrate_project_releases(self) -> None:
        await self.driver.execute_query(
            '''
            MATCH (owner:FuliPrincipal)-[:OWNS]->
                  (space:FuliSpace {kind: 'project', visibility: 'public'})
            WHERE space.release_version IS NULL
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

    async def _migrate_legacy_group_ids(self) -> None:
        records, _, _ = await self.driver.execute_query(
            "MATCH (s:FuliSpace) WHERE s.group_id CONTAINS ':' "
            'RETURN s.id AS id, s.group_id AS group_id',
            routing_='r',
        )
        for record in records:
            previous = record['group_id']
            current = previous.replace(':', '-')
            async with self.driver.transaction() as transaction:
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

    async def _migrate_knowledge_lifecycle_defaults(self) -> None:
        await self.driver.execute_query(
            '''
            MATCH (item:Entity)
            WHERE item.fuli_utility_score IS NULL
               OR item.fuli_confidence_score IS NULL
               OR item.fuli_qualified_use_count IS NULL
               OR item.fuli_distinct_task_count IS NULL
               OR item.fuli_usage_generation IS NULL
               OR item.fuli_inheritance_mode IS NULL
               OR item.fuli_inherited_project_ids IS NULL
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
        )
        await self.driver.execute_query(
            '''
            MATCH ()-[item:RELATES_TO]->()
            WHERE item.fuli_utility_score IS NULL
               OR item.fuli_confidence_score IS NULL
               OR item.fuli_qualified_use_count IS NULL
               OR item.fuli_distinct_task_count IS NULL
               OR item.fuli_usage_generation IS NULL
               OR item.fuli_inheritance_mode IS NULL
               OR item.fuli_inherited_project_ids IS NULL
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
        )

    async def close(self) -> None:
        await self.graphiti.close()
