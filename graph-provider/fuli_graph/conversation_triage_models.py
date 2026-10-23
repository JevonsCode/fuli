"""Jefa's triage labels for conversations that no project has claimed yet."""
from typing import Literal
from pydantic import Field, model_validator
from .models import StrictModel
from .model_validation import reject_credentials


class ConversationTriageWrite(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    conversation_id: str = Field(min_length=1, max_length=128)
    kind: Literal['project', 'topic', 'one_off']
    personal_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    topic: str | None = Field(default=None, min_length=1, max_length=80)
    # A person's correction outranks the host's label and is never overwritten by it.
    source: Literal['host', 'user'] = 'host'

    @model_validator(mode='after')
    def label_matches_kind(self):
        if (self.kind == 'project') != (self.personal_project_id is not None):
            raise ValueError('Only a project label names a project')
        if (self.kind == 'topic') != (self.topic is not None and bool(self.topic.strip())):
            raise ValueError('Only a topic label names a topic')
        reject_credentials(self, 'Conversation triage')
        return self


class ConversationTopicQuery(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    limit: int = Field(default=8, ge=1, le=50)
    # One topic only, for example the one a conversation was just labelled with.
    topic: str | None = Field(default=None, min_length=1, max_length=80)
    min_count: int = Field(default=1, ge=1, le=1000)


class ConversationTopicFormation(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    topic: str = Field(min_length=1, max_length=80)
    personal_project_id: str = Field(min_length=1, max_length=128)


class ConversationTriageRead(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    conversation_id: str = Field(min_length=1, max_length=128)


class ConversationTopicDecline(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    topic: str = Field(min_length=1, max_length=80)
