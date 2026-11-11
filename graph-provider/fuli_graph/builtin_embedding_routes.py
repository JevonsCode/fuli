"""The route that runs a downloaded embedding model (builtin_embedding.py).

Node asks with the model's catalog id and the texts; it gets vectors and how
many tokens they were. The texts never leave this computer.
"""
import asyncio
from typing import Annotated

from fastapi import HTTPException
from pydantic import Field

from .builtin_embedding import BuiltinEmbeddingError, BuiltinEmbeddings
from .model_base import StrictModel

MAX_TEXTS = 64
MAX_TEXT_CHARS = 32_000


class BuiltinEmbeddingRequest(StrictModel):
    model: str = Field(min_length=1, max_length=64)
    texts: list[Annotated[str, Field(max_length=MAX_TEXT_CHARS)]] = Field(min_length=1, max_length=MAX_TEXTS)


class BuiltinEmbeddingAnswer(StrictModel):
    model: str
    dimensions: int
    vectors: list[list[float]]
    tokens: int


# Not on this computer is the caller's to fix (download it); a file this version cannot run is refused.
_STATUS = {'model_missing': 404, 'builtin_unavailable': 404, 'model_unsupported': 422, 'model_invalid': 422}


def register_builtin_embedding_routes(application, settings, Actor) -> None:
    models = BuiltinEmbeddings(settings.embedding_models_dir)

    @application.post('/v1/builtin-embeddings', response_model=BuiltinEmbeddingAnswer)
    async def builtin_embeddings(request: BuiltinEmbeddingRequest, actor: Actor):
        try:
            # The forward pass is CPU work: off the event loop, so other requests go on.
            return await asyncio.to_thread(models.embed, request.model, request.texts)
        except BuiltinEmbeddingError as error:
            raise HTTPException(status_code=_STATUS.get(error.code, 422),
                                detail={'code': error.code, 'message': str(error)}) from error

    @application.post('/v1/builtin-embeddings/unload', status_code=204)
    async def unload_builtin_embeddings(actor: Actor):
        # Before a model's files are removed: Windows keeps a mapped file from being deleted.
        models.unload()
