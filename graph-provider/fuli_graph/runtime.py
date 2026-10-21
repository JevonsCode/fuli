import hashlib
import math
import os
import re
import unicodedata
from collections.abc import Iterable
from contextlib import asynccontextmanager
from typing import Any

os.environ.setdefault('GRAPHITI_TELEMETRY_ENABLED', 'false')

from graphiti_core import Graphiti
from graphiti_core.cross_encoder.client import CrossEncoderClient
from graphiti_core.driver.neo4j_driver import Neo4jDriver, _Neo4jTransaction
from graphiti_core.embedder.client import EmbedderClient
from graphiti_core.llm_client.client import LLMClient
from graphiti_core.llm_client.config import LLMConfig, ModelSize
from graphiti_core.prompts.models import Message
from neo4j import READ_ACCESS, WRITE_ACCESS, RoutingControl
from neo4j.exceptions import ClientError
from pydantic import BaseModel

from .config import Settings
from .graph_format import UNCHECKED, prepare_graph_format

_ACCESS_MODE_ERROR = 'Neo.ClientError.Statement.AccessMode'


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

    # Names the feature hashing; changing it changes every similarity score.
    version = 'fuli-embed-v1'

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
                person=self.version.encode('ascii'),
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


class ManagedNeo4jDriver(Neo4jDriver):
    """The provider's only graph connection, held to the graph's data format.

    The format registry (graph_format.py) declares and creates every index
    and constraint, Graphiti's included, so the dependency's own index build,
    scheduled eagerly whenever its driver is constructed inside a running
    event loop, never runs.

    Every query passes the format check first: until prepare_graph_format has
    decided, nothing runs; a read-only graph runs every query in Neo4j's read
    access mode, so the database itself refuses a write; a refused graph runs
    nothing. Only the maintenance handle, used by the format check itself,
    bypasses this.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.format = UNCHECKED

    def build_indices_and_constraints(self, delete_existing: bool = False):
        return _completed_index_build()

    def maintenance(self) -> '_MaintenanceDriver':
        return _MaintenanceDriver(self)

    def read_only(self) -> '_ReadOnlyDriver':
        """Reads for the format report, in Neo4j's read access mode whatever
        the format state: Neo4j itself refuses any write through it."""
        return _ReadOnlyDriver(self)

    def _access_mode(self) -> str:
        if self.format.access == 'none':
            raise self.format.refusal()
        return READ_ACCESS if self.format.access == 'read' else WRITE_ACCESS

    def _refused_write(self, error: ClientError) -> bool:
        return self.format.access == 'read' and error.code == _ACCESS_MODE_ERROR

    async def execute_query(self, cypher_query_, **kwargs):
        if self._access_mode() == READ_ACCESS:
            kwargs['routing_'] = RoutingControl.READ
        try:
            return await super().execute_query(cypher_query_, **kwargs)
        except ClientError as error:
            if self._refused_write(error):
                raise self.format.refusal() from error
            raise

    def transaction(self):
        if self._access_mode() == WRITE_ACCESS:
            return super().transaction()
        return self._read_only_transaction()

    @asynccontextmanager
    async def _read_only_transaction(self):
        try:
            async with self.client.session(
                database=self._database, default_access_mode=READ_ACCESS
            ) as session:
                tx = await session.begin_transaction()
                try:
                    yield _Neo4jTransaction(tx)
                    await tx.commit()
                except BaseException:
                    await tx.rollback()
                    raise
        except ClientError as error:
            if self._refused_write(error):
                raise self.format.refusal() from error
            raise

    def session(self, database: str | None = None):
        mode = self._access_mode()
        return self.client.session(
            database=database or self._database, default_access_mode=mode
        )


class _MaintenanceDriver:
    """Unguarded access for the format check and its migrations only."""

    def __init__(self, driver: ManagedNeo4jDriver):
        self._driver = driver

    async def execute_query(self, cypher_query_, **kwargs):
        return await Neo4jDriver.execute_query(self._driver, cypher_query_, **kwargs)

    def transaction(self):
        return Neo4jDriver.transaction(self._driver)


class _ReadOnlyDriver:
    def __init__(self, driver: ManagedNeo4jDriver):
        self._driver = driver

    async def execute_query(self, cypher_query_, **kwargs):
        kwargs['routing_'] = RoutingControl.READ
        return await Neo4jDriver.execute_query(self._driver, cypher_query_, **kwargs)


async def _completed_index_build() -> None:
    return None


class GraphitiRuntime:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.embedder = LocalHashEmbedder(settings.embedding_dim)
        driver = ManagedNeo4jDriver(
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

    @property
    def data_format(self):
        return self.driver.format

    async def initialize(self) -> None:
        """Check the graph's data format before any schema change or write."""
        await self.refresh_data_format()

    async def refresh_data_format(self) -> None:
        """Decide again what the provider may do: at start, and after a person
        applied or undid a migration (graph_format_routes.py)."""
        self.driver.format = await prepare_graph_format(self.driver.maintenance(), self.settings)
        if self.driver.format.access == 'write':
            await self._ensure_personal_space_defaults()

    async def _ensure_personal_space_defaults(self) -> None:
        """Every personal space has its recruitment policy and system Agents.

        Not a format migration: the same idempotent defaults are also ensured
        on demand when a space's Project Agents are listed or recruited, and
        this runs only once the graph is writable.
        """
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
        from .system_agents import ensure_system_agents

        for record in records:
            await ensure_system_agents(self.driver, self.settings.provider_id, record['space_id'])

    async def close(self) -> None:
        await self.graphiti.close()
