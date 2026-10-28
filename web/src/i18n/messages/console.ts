export const consoleMessages = {
  'zh-CN': {
    brandEffect: {
      aria: '复利，触发品牌光效',
    },
    update: {
      aria: '发现新版本 {version}，查看更新方法',
      title: '新版本 v{version} 可用',
      copy: '更新时 FULI 会先停止，装好新版本后自动重新启动，期间页面会断开一会儿，完成后自动刷新。知识数据不会被删除。',
      action: '更新到 v{version}',
      running: '正在更新到 v{version}，FULI 重新启动后页面会自动刷新…',
      unchanged: '没有需要安装的新版本，FULI 没有停止。',
      failed: '没有更新完成：{reason}',
      notBack: 'FULI 还没有重新应答，请稍后刷新这个页面。',
      trayCopy: '会下载并校验 v{version} 的 Windows 安装包，关闭 FULI 桌面客户端，停止 FULI 后换成新版本，再启动 FULI，并重新打开原来开着的桌面客户端；页面会断开一会儿，完成后自动刷新。知识数据和旧版本都会保留，可以回退。',
      steps: {
        downloading: '正在下载 v{version} 的 Windows 安装包…',
        verifying: '正在校验 v{version} 的安装包…',
        exitingTray: '正在关闭 FULI 桌面客户端，它手上的操作结束后继续…',
        installing: '正在更新到 v{version}，FULI 重新启动后页面会自动刷新…',
      },
      blockers: '这些仍在运行的 FULI 程序不是这个安装启动的，FULI 没有动它们：',
      blocker: '{role}，进程 {pid}：{program}',
      roles: {
        console: '管理页',
        database: '图数据库',
        provider: '图服务',
      },
      unknownProgram: '程序未知',
      stopAndRetry: '停止它们并重新更新',
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
      copy: 'FULI stops while it updates, installs the new version and starts again by itself; this page disconnects for a moment and reloads when it is done. Your knowledge data is not deleted.',
      action: 'Update to v{version}',
      running: 'Updating to v{version}; this page reloads once FULI has started again…',
      unchanged: 'There was no newer version to install; FULI was not stopped.',
      failed: 'The update did not finish: {reason}',
      notBack: 'FULI has not answered again yet. Reload this page in a moment.',
      trayCopy: 'Downloads and verifies the v{version} Windows package, closes the FULI desktop client, stops FULI and switches to the new version, then starts FULI and reopens the desktop client if it was open; this page disconnects for a moment and reloads when it is done. Your knowledge data and the previous version are kept, so you can go back.',
      steps: {
        downloading: 'Downloading the v{version} Windows package…',
        verifying: 'Verifying the v{version} package…',
        exitingTray: 'Closing the FULI desktop client; it finishes its current action first…',
        installing: 'Updating to v{version}; this page reloads once FULI has started again…',
      },
      blockers: 'These FULI programs are still running and were not started by this installation, so FULI left them alone:',
      blocker: '{role}, process {pid}: {program}',
      roles: {
        console: 'Console',
        database: 'Graph database',
        provider: 'Graph service',
      },
      unknownProgram: 'unknown program',
      stopAndRetry: 'Stop them and update again',
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
