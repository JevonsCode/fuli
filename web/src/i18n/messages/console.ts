export const consoleMessages = {
  'zh-CN': {
    brandEffect: {
      aria: '复利，触发品牌光效',
    },
    update: {
      aria: '发现新版本 {version}，查看更新方法',
      title: '新版本 v{version} 可用',
      copy: '在终端运行：',
      npmLink: '在 npm 查看版本详情',
    },
    agentAccess: {
      enabledNotice: 'Agent 使用已开启；已连接的 Agent 可以调用 FULI。',
      disabledNotice: 'Agent 使用已关闭，所有 Agent 调用会被拦截。',
    },
    recall: {
      directNotice: '已开启：Agent 会直接使用你确认过的知识回答。',
      verifyNotice: '已关闭：Agent 每次都会去文件里核对已确认的知识。',
    },
    captureNotices: {
      enabled: '自动沉淀已开启。',
      disabled: '自动沉淀已关闭，已有知识仍可读取。',
    },
  },
  'en-US': {
    brandEffect: {
      aria: 'FULI, play the brand light effect',
    },
    update: {
      aria: 'Version {version} is available. View update instructions',
      title: 'Version v{version} is available',
      copy: 'Run in a terminal:',
      npmLink: 'View version details on npm',
    },
    agentAccess: {
      enabledNotice: 'Agent access is on. Connected Agents can use FULI.',
      disabledNotice: 'Agent access is off; all Agent calls are blocked.',
    },
    recall: {
      directNotice: 'On: Agents answer from knowledge you confirmed.',
      verifyNotice: 'Off: Agents check confirmed knowledge against the files every time.',
    },
    captureNotices: {
      enabled: 'Automatic capture is on.',
      disabled: 'Automatic capture is off; existing knowledge stays readable.',
    },
  },
} as const
