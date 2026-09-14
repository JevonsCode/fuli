export const attentionMessages = {
  'zh-CN': {
    title: '待你处理', count: '{count} 件事待你处理', all: '全部 Agent', refresh: '刷新', close: '关闭',
    loading: '正在读取待处理的 Agent 请求…', loadingAgents: '正在读取 Agent 名录…',
    loadError: '待办读取失败，请重试', empty: '暂时没有需要你处理的事情',
    response: '你的回复', send: '回复并处理', sending: '正在提交 Agent 请求答复…', more: '加载更多', task: '查看 Agent 任务',
    displayName: '名字', roleName: '岗位名称',
    kinds: { question: '需要答复', approval: '需要决定', review: '需要验收', permission: '需要权限', blocked: '需要协助' },
  },
  'en-US': {
    title: 'Needs you', count: '{count} requests need you', all: 'All Agents', refresh: 'Refresh', close: 'Close',
    loading: 'Loading pending Agent requests…', loadingAgents: 'Loading the Agent directory…',
    loadError: 'Could not load requests. Try again', empty: 'Nothing needs your attention',
    response: 'Your reply', send: 'Reply and resolve', sending: 'Submitting the Agent request response…', more: 'Load more', task: 'View Agent tasks',
    displayName: 'Name', roleName: 'Role name',
    kinds: { question: 'Question', approval: 'Decision', review: 'Review', permission: 'Permission', blocked: 'Help needed' },
  },
}
