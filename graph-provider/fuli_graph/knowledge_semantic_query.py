"""What a search by meaning carries and answers (rec#88)."""
from typing import Annotated, Literal

from pydantic import Field

from .model_base import StrictModel

# How search found an item: by its words, by its meaning, or both.
SearchMatch = Literal['lexical', 'semantic', 'both']
SemanticVectorValues = Annotated[
    list[Annotated[float, Field(allow_inf_nan=False)]], Field(min_length=1, max_length=8192)]


class SemanticQuery(StrictModel):
    """The query's own meaning vector, computed by the model a person
    connected. A model or length no stored vector has is no error: the
    search then has no semantic part."""
    model: str = Field(min_length=1, max_length=256)
    vector: SemanticVectorValues
