export const agentPinsMessages = {
  'zh-CN': {
    navigation: {
      title: 'pin',
    },
    pin: '置顶',
    unpin: '取消置顶',
    loading: '正在读取 pin…',
    saving: '正在保存置顶…',
    loadError: '暂时无法读取 pin。',
    saveError: '暂时无法保存 pin。',
    conflictError: 'pin 列表已更新，请重试。',
    retry: '重试',
  },
  'en-US': {
    navigation: {
      title: 'pin',
    },
    pin: 'Pin',
    unpin: 'Unpin',
    loading: 'Reading pin…',
    saving: 'Saving pin…',
    loadError: 'pin is temporarily unavailable.',
    saveError: 'The pin could not be saved.',
    conflictError: 'The pin list changed. Try again.',
    retry: 'Retry',
  },
} as const
