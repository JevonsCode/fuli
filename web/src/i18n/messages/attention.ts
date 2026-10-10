export const attentionMessages = {
  'zh-CN': {
    title: '待你处理', count: '{count} 件事待你处理', all: '全部 Agent', refresh: '刷新', close: '关闭',
    loading: '正在读取待处理的 Agent 请求…',
    loadError: '待办读取失败，请重试', empty: '暂时没有需要你处理的事情',
    response: '你的回复', send: '提交回复', sending: '正在提交 Agent 请求答复…', more: '加载更多', task: '查看 Agent 任务',
    context: '背景与详情', chooseReply: '选择回复', other: '其他回复', note: '补充说明（选填）', placeholder: '写下你的想法…', replyHint: '回复只记录你的决定，不会直接执行或授权。', tooLong: '回复过长，请精简至 4096 字以内。', queue: '待处理请求', selectRequest: '选择请求', agentFallback: 'Agent', projectFallback: '项目', updated: '请求已更新，请重新确认回复。', wrongSpace: '请求属于其他空间，请重新打开后回复。',
    replies: { agree: '同意此方案', decline: '暂不同意', accept: '审核通过', revise: '需要修改', resolved: '已处理，可以继续', clarify: '请补充信息' },
    displayName: '名字', roleName: '岗位名称',
    kinds: { question: '需要答复', approval: '需要决定', review: '需要验收', permission: '需要权限', blocked: '需要协助' },
  },
  'en-US': {
    title: 'Needs you', count: '{count} requests need you', all: 'All Agents', refresh: 'Refresh', close: 'Close',
    loading: 'Loading pending Agent requests…',
    loadError: 'Could not load requests. Try again', empty: 'Nothing needs your attention',
    response: 'Your reply', send: 'Reply and resolve', sending: 'Submitting the Agent request response…', more: 'Load more', task: 'View Agent tasks',
    context: 'Background & details', chooseReply: 'Choose a reply', other: 'Something else', note: 'Add a note (optional)', placeholder: 'Share your thoughts…', replyHint: 'Records your decision only; nothing is executed or granted.', tooLong: 'Shorten your reply to 4096 characters.', queue: 'Pending requests', selectRequest: 'Select a request', agentFallback: 'Agent', projectFallback: 'Project', updated: 'This request changed. Please review your reply.', wrongSpace: 'This request belongs to a different space. Reopen it before replying.',
    replies: { agree: 'Agree with this proposal', decline: 'Do not agree at this time', accept: 'Review passed', revise: 'Changes needed', resolved: 'Resolved, ready to continue', clarify: 'More information needed' },
    displayName: 'Name', roleName: 'Role name',
    kinds: { question: 'Question', approval: 'Decision', review: 'Review', permission: 'Permission', blocked: 'Help needed' },
  },
}
