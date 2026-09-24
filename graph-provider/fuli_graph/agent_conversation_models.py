"""Private visible conversation events, separate from reviewed working memory."""
from typing import Literal
from pydantic import Field, model_validator
from .models import StrictModel, SourceApplication
from .model_validation import reject_credentials


class ConversationPolicy(StrictModel):
    idle_days: int = Field(default=7, ge=1, le=365)
    context_budget: int = Field(default=2000, ge=512, le=16000)
    enabled: bool = True


class ConversationScope(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str = Field(min_length=1, max_length=128)
    agent_id: str = Field(min_length=1, max_length=128)
    source_application: SourceApplication | None = None


class ConversationQuery(ConversationScope):
    conversation_id: str | None = Field(default=None, min_length=1, max_length=128)
    session_id: str | None = Field(default=None, min_length=1, max_length=256)
    mode: Literal['list', 'context', 'events', 'session', 'policy'] = 'list'
    after: int = Field(default=0, ge=0)
    limit: int = Field(default=20, ge=1, le=50)


class ConversationEvent(StrictModel):
    event_id: str = Field(min_length=1, max_length=256)
    role: Literal['user', 'assistant', 'tool', 'summary']
    content: str = Field(min_length=1, max_length=131072)
    kind: Literal['message', 'tool_call', 'tool_result', 'checkpoint'] = 'message'

    @model_validator(mode='after')
    def reject_secrets(self):
        reject_credentials(self, 'Conversation event')
        return self


class ConversationWrite(ConversationScope):
    source_application: SourceApplication
    session_id: str = Field(min_length=1, max_length=256)
    task_context_token: str = Field(min_length=1, max_length=160)
    events: list[ConversationEvent] = Field(default_factory=list, max_length=50)
    summary: str | None = Field(default=None, max_length=2000)
    status: Literal['reported', 'completed', 'incomplete', 'failed', 'no_change', 'unreported'] | None = None
    # A byte cursor for this exact source session; advance only with committed events.
    cursor: int | None = Field(default=None, ge=0)
    expected_cursor: int | None = Field(default=None, ge=0)
    initialize_cursor: bool = False

    @model_validator(mode='after')
    def bounded_batch(self):
        if sum(len(e.content.encode()) for e in self.events) > 512 * 1024:
            raise ValueError('Conversation batch exceeds 512 KiB')
        if (self.cursor is None) != (self.expected_cursor is None):
            raise ValueError('Both transcript cursors are required')
        if self.cursor is not None and self.cursor < self.expected_cursor:
            raise ValueError('Transcript cursor cannot move backwards')
        return self


class ConversationResume(ConversationScope):
    source_application: SourceApplication
    session_id: str = Field(min_length=1, max_length=256)
    task_context_token: str = Field(min_length=1, max_length=160)
    conversation_id: str = Field(min_length=1, max_length=128)


class ConversationPolicyWrite(ConversationScope):
    policy: ConversationPolicy
