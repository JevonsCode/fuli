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
        await self._migrate_space_visibility_and_owners()
        await self._migrate_project_releases()
        await self._migrate_legacy_group_ids()

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

    async def close(self) -> None:
        await self.graphiti.close()
