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
    graph_limit: int = 500
    search_limit: int = 20

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
