"""Private visible conversation events, separate from reviewed working memory."""
from typing import Literal
from pydantic import Field, model_validator
from .models import StrictModel, SourceApplication
from .model_validation import contains_credentials, reject_credentials


class ConversationPolicy(StrictModel):
    # Fold older messages into the digest once this much unfolded text accumulates.
    compact_after_kb: int = Field(default=64, ge=8, le=1024)
    context_budget: int = Field(default=4000, ge=512, le=16000)
    enabled: bool = True

    @model_validator(mode='before')
    @classmethod
    def drop_retired_idle_days(cls, value):
        # Policies saved before size-based compaction carried an inactivity window.
        if isinstance(value, dict) and 'idle_days' in value:
            value = {key: item for key, item in value.items() if key != 'idle_days'}
        return value


class ConversationScope(StrictModel):
    personal_space_id: str = Field(min_length=1, max_length=128)
    personal_project_id: str | None = Field(default=None, min_length=1, max_length=128)
    agent_id: str = Field(min_length=1, max_length=128)
    source_application: SourceApplication | None = None


class ConversationQuery(ConversationScope):
    conversation_id: str | None = Field(default=None, min_length=1, max_length=128)
    session_id: str | None = Field(default=None, min_length=1, max_length=256)
    mode: Literal['list', 'context', 'events', 'session', 'policy'] = 'list'
    # list only: the open conversations of one unclaimed-conversation topic.
    topic: str | None = Field(default=None, min_length=1, max_length=80)
    after: int = Field(default=0, ge=0)
    limit: int = Field(default=20, ge=1, le=50)
    # list only: for a progress view, each conversation's latest task result with
    # evidence (a checkpoint that is not an automatic close) and its latest task-activity
    # receipt from a native session certainly bound to it; summaries cut to 400 bytes.
    with_progress: bool = False
    # list only: a keyset page, starting after this position of the newest-first order
    # (last_activity descending, then id), so a deep page costs what the first one does.
    after_activity: str | None = Field(default=None, min_length=1, max_length=64)
    after_id: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode='after')
    def position_is_whole(self):
        if (self.after_activity is None) != (self.after_id is None):
            raise ValueError('after_activity and after_id are given together')
        return self


class ConversationEvent(StrictModel):
    event_id: str = Field(min_length=1, max_length=256)
    role: Literal['user', 'assistant', 'tool', 'summary']
    content: str = Field(min_length=1, max_length=131072)
    # compaction_summary: the summary an Agent client wrote when it compacted its own context.
    kind: Literal['message', 'tool_call', 'tool_result', 'checkpoint', 'compaction_summary'] = 'message'

    @model_validator(mode='after')
    def reject_secrets(self):
        reject_credentials(self, 'Conversation event')
        return self


class ConversationProvenance(StrictModel):
    """Where a host session works, so a conversation can be traced to it: the
    folder its client ran in, the model the client reported, and the person's
    opening words (the conversation's title until a checkpoint summarises it)."""
    working_directory: str | None = Field(default=None, min_length=1, max_length=1024)
    model: str | None = Field(default=None, min_length=1, max_length=120)
    branch: str | None = Field(default=None, min_length=1, max_length=255)
    title: str | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode='after')
    def drop_secrets(self):
        # Where a session works is a note, never a reason to refuse its task
        # entry: a value that looks like a credential is left out instead.
        for field in ('working_directory', 'model', 'branch', 'title'):
            if contains_credentials(getattr(self, field)):
                setattr(self, field, None)
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
    fallback_recovery: bool = False
    provenance: ConversationProvenance | None = None

    @model_validator(mode='after')
    def bounded_batch(self):
        if sum(len(e.content.encode()) for e in self.events) > 512 * 1024:
            raise ValueError('Conversation batch exceeds 512 KiB')
        if (self.cursor is None) != (self.expected_cursor is None):
            raise ValueError('Both transcript cursors are required')
        if self.cursor is not None and self.cursor < self.expected_cursor:
            raise ValueError('Transcript cursor cannot move backwards')
        return self


class ConversationBegin(ConversationScope):
    """A task entry: recover this session's conversation and open this task's (rec#11 D-53)."""
    source_application: SourceApplication
    session_id: str = Field(min_length=1, max_length=256)
    task_context_token: str = Field(min_length=1, max_length=160)
    provenance: ConversationProvenance | None = None


class ConversationResume(ConversationScope):
    source_application: SourceApplication
    session_id: str = Field(min_length=1, max_length=256)
    task_context_token: str = Field(min_length=1, max_length=160)
    conversation_id: str = Field(min_length=1, max_length=128)


class ConversationPolicyWrite(ConversationScope):
    policy: ConversationPolicy
