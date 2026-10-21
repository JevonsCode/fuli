// rec#5 C6: what one session recorded, opened from a receipt or a knowledge source.
export const sessionRecordsMessages = {
  'zh-CN': {
    lede: '{client} 会话 {session} 记下的内容：保存的原话、新增或更新的知识、被当成偏好依据的话。',
    total: '共 {count} 项',
    loading: '正在读取本会话记录',
    loadFailed: '读不到本会话记录：{error}',
    retry: '重试',
    empty: '这个会话还没有记录任何内容。',
    truncated: '会话较长，这里只列出最近的记录。',
    noTime: '时间未记录',
    noProject: '无项目',
    groups: {
      transcript: '会话原文', knowledge: '知识', preference_evidence: '偏好证据',
    },
    groupEmpty: {
      transcript: '没有保存原话。', knowledge: '没有新增或更新的知识。', preference_evidence: '没有话被当成偏好依据。',
    },
    type: { turn: '会话原文', evidence: '偏好证据', created: '新增', updated: '更新' },
    stretch: {
      paused: '{from}～{to} 暂停记录', notRecorded: '{from}～{to} 未记录',
      empty: '这段时间没有任何记录。',
    },
    open: '查看第 {number} 项',
    peek: {
      words: '这一轮的原话', reply: 'Agent 的回答（节选）', records: '这一轮记下的', noRecords: '这一轮没有记下知识或偏好证据。',
      evidence: '被当成依据的原话', fromTurn: '来自第 {number} 项：这一轮的原话', edit: '修改这条知识',
      notSaved: '这一轮的原话没有保存；下面是被当成依据的那句话。',
      missing: '这个会话里找不到这一项。',
    },
    fromSession: '来自哪个会话',
  },
  'en-US': {
    lede: 'What the {client} session {session} recorded: words it saved, knowledge it added or updated, and what became preference evidence.',
    total: '{count} records',
    loading: 'Reading this session\'s records',
    loadFailed: 'Could not read this session\'s records: {error}',
    retry: 'Retry',
    empty: 'This session has recorded nothing yet.',
    truncated: 'This session is long; only its latest records are listed.',
    noTime: 'Time not recorded',
    noProject: 'No project',
    groups: {
      transcript: 'Saved words', knowledge: 'Knowledge', preference_evidence: 'Preference evidence',
    },
    groupEmpty: {
      transcript: 'No words were saved.', knowledge: 'No knowledge was added or updated.',
      preference_evidence: 'Nothing said became preference evidence.',
    },
    type: { turn: 'Saved words', evidence: 'Preference evidence', created: 'New', updated: 'Updated' },
    stretch: {
      paused: '{from}–{to} recording paused', notRecorded: '{from}–{to} not recorded',
      empty: 'Nothing was recorded in this stretch.',
    },
    open: 'Open record {number}',
    peek: {
      words: 'What was said this turn', reply: 'The Agent\'s answer (excerpt)', records: 'Recorded from this turn',
      noRecords: 'This turn recorded no knowledge or preference evidence.', evidence: 'The words used as evidence',
      fromTurn: 'From record {number}: the words of this turn', edit: 'Edit this knowledge',
      notSaved: 'This turn\'s words were not saved; below are the words used as evidence.',
      missing: 'This session has no such record.',
    },
    fromSession: 'Which session it came from',
  },
} as const
