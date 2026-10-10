export const agentPinsMessages = {
  'zh-CN': {
    navigation: {
      title: '置顶 Agents',
      empty: '暂未置顶 Agent',
    },
    pin: '置顶 Agent',
    unpin: '取消置顶 Agent',
    loading: '正在读取已置顶 Agent…',
    saving: '正在保存 Agent 置顶…',
    loadError: '暂时无法读取已置顶 Agent。',
    saveError: '暂时无法保存 Agent 置顶。',
    conflictError: '置顶列表已更新，请重试。',
    retry: '重试',
  },
  'en-US': {
    navigation: {
      title: 'Pinned Agents',
      empty: 'No pinned Agents',
    },
    pin: 'Pin Agent',
    unpin: 'Unpin Agent',
    loading: 'Reading pinned Agents…',
    saving: 'Saving Agent pin…',
    loadError: 'Pinned Agents are temporarily unavailable.',
    saveError: 'The Agent pin could not be saved.',
    conflictError: 'The pin list changed. Try again.',
    retry: 'Retry',
  },
} as const
