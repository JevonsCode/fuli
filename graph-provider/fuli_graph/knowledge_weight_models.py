from pydantic import Field

from .model_base import StrictModel


class KnowledgeWeightView(StrictModel):
    """The weight search ranks by (knowledge_weight); never an authorization input."""
    weight_percent: int = Field(default=10, ge=0, le=100)
    confirmed_by_person: bool = False
