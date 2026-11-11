export const shellMessages = {
  'zh-CN': {
    aria: '主导航', refreshPage: '刷新这一页', refreshingPage: '正在刷新这一页', sectionsAria: '本页分区', runtimeReady: '本机服务运行中', runtimeOffline: '本机服务未就绪', versionLink: '版本 v{version}，打开版本设置', versionUpdate: '版本 v{version}，有新版本 v{latest}，打开版本设置', attentionWaiting: '待决策：{count} 件事在等你', settingsClientsUpdate: '设置：有客户端要更新接入', peek: { count: '{count} 件', request: 'Agent 请求', question: "@:{'roleNames.tonborg'} 问你", confirm: '待确认', empty: '现在没有要你决定的事。', more: '还有 {count} 件，去处理', go: '去处理' },
    destinations: { constellation: '工作台', agents: 'FLAs', chat: '圆桌', projects: '项目', memory: '沉淀', settings: '设置' },
    sections: {
      agentDirectory: '全部', orchestrate: '编排', occupations: '职业', services: '服务', apps: 'Agent App',
      roundtables: '讨论', askedYou: '待决策', myProjects: '我的', publicProjects: '公开',
      knowledge: '知识', preferences: '偏好',organize: '知识整理', tags: '标签',
      settings: '常规', connections: '连接', about: '关于', howto: '常用操作',
    },
  },
  'en-US': {
    aria: 'Main navigation', refreshPage: 'Refresh this page', refreshingPage: 'Refreshing this page', sectionsAria: 'Sections', runtimeReady: 'Local services running', runtimeOffline: 'Local services not ready', versionLink: 'Version v{version}, open version settings', versionUpdate: 'Version v{version}, v{latest} is available, open version settings', attentionWaiting: 'Decisions: {count} waiting for you', settingsClientsUpdate: 'Settings: a client needs its FULI update', peek: { count: '{count} waiting', request: 'Agent asks', question: "@:{'roleNames.tonborg'} asks", confirm: 'To confirm', empty: 'Nothing waits for your decision.', more: '{count} more, open', go: 'Open' },
    destinations: { constellation: 'Workspace', agents: 'FLAs', chat: 'Roundtable', projects: 'Projects', memory: 'Memory', settings: 'Settings' },
    sections: {
      agentDirectory: 'All', orchestrate: 'Orchestrate', occupations: 'Occupations', services: 'Services', apps: 'Apps',
      roundtables: 'Discussions', askedYou: 'Decisions', myProjects: 'Mine', publicProjects: 'Public',
      knowledge: 'Knowledge', preferences: 'Preferences',organize: 'Organize', tags: 'Tags',
      settings: 'General', connections: 'Connections', about: 'About', howto: 'How-to',
    },
  },
} as const