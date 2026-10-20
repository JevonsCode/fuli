from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix='FULI_', extra='ignore')

    provider_mode: Literal['personal', 'workspace'] = 'personal'
    provider_id: str = 'local-personal'
    provider_name: str = 'Fuli Personal Provider'
    bootstrap_token: str = Field(min_length=24)
    human_review_token: str | None = Field(default=None, min_length=32)
    workflow_observation_token: str | None = Field(
        default=None,
        min_length=32,
    )
    neo4j_uri: str = 'bolt://neo4j:7687'
    neo4j_user: str = 'neo4j'
    neo4j_password: str = Field(min_length=8)
    neo4j_database: str = 'neo4j'
    embedding_dim: int = 384
    # Cosine of the local lexical-hash embedding at which a tag is proposed as a
    # similar candidate; it is never merged. Unrelated random names stay below it
    # (measured in test_knowledge_tags_http.py).
    tag_similarity_threshold: float = Field(default=0.35, gt=0, le=1)
    graph_limit: int = 500
    search_limit: int = 20
    staffing_demand_window_days: int = Field(default=30, ge=1, le=365)
    staffing_demand_task_threshold: int = Field(default=5, ge=0, le=100000)

    @field_validator('provider_id')
    @classmethod
    def validate_provider_id(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized or len(normalized) > 128:
            raise ValueError('provider_id must contain 1 to 128 characters')
        return normalized


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
