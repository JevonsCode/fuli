// The beginner's guide (features/onboarding-tour): what FULI is and where each
// part lives, one short step at a time, plus its row in 设置 › 系统 › 界面.
export const onboardingTourMessages = {
  'zh-CN': {
    title: '新手引导',
    progress: '第 {step} 步，共 {total} 步：{title}',
    back: '上一步',
    next: '下一步',
    done: '完成',
    skip: '跳过',
    paused: '新手引导停在第 {step} 步',
    resume: '继续',
    settingsRow: '新手引导',
    showAgain: '再看一遍',
    steps: {
      what: {
        title: 'FULI 帮你的 AI 记事',
        text: '你照常在 Claude Code、Codex、Cursor 等 AI 客户端里干活。FULI 记下值得留的，之后的任务用得上时再交给 AI。',
      },
      clients: {
        title: '先接入你的客户端',
        text: '在 设置 › 客户端 点一下就能接入一个客户端。哪个客户端的接入需要更新，那里会写出来。',
        go: '去接入客户端',
      },
      reply: {
        title: '回复末尾有一行 FULI',
        text: '照常干活，AI 的回复末尾会有一行 FULI，写着这次是哪个 FLA 在做。FLA 是 FULI 里有自己记忆和角色的 Agent。',
        go: '看看你的 FLA',
      },
      memory: {
        title: '记下的都在「沉淀」',
        text: 'FULI 记下的都在「沉淀」，由你确认、修改或删掉。等你拿主意的事在「待决策」。',
        go: '去沉淀',
      },
      projects: {
        title: '每个项目有一位负责人',
        text: '每个项目由一位 FLA 负责，它记得这个项目的事。',
        go: '去项目',
      },
      roundtable: {
        title: 'FLA 在圆桌上商量',
        text: 'FLA 们在「圆桌」互相沟通，不管各自在哪个客户端。你也可以在那里给它们留言。',
        go: '去圆桌',
      },
    },
  },
  'en-US': {
    title: "Beginner's guide",
    progress: 'Step {step} of {total}: {title}',
    back: 'Back',
    next: 'Next',
    done: 'Done',
    skip: 'Skip',
    paused: "Beginner's guide paused at step {step}",
    resume: 'Continue',
    settingsRow: "Beginner's guide",
    showAgain: 'Show again',
    steps: {
      what: {
        title: 'FULI remembers for your AI',
        text: 'Keep working in your AI client, such as Claude Code, Codex or Cursor. FULI keeps what is worth keeping and hands it back when a later task needs it.',
      },
      clients: {
        title: 'Connect your clients',
        text: 'In Settings › Clients, one click connects a client. A client whose connection needs an update says so there.',
        go: 'Connect clients',
      },
      reply: {
        title: 'A FULI line in each reply',
        text: 'Work as usual: a reply ends with a FULI line naming the FLA that did the work. An FLA is a FULI Agent with its own memory and role.',
        go: 'See your FLAs',
      },
      memory: {
        title: 'What FULI kept is in Memory',
        text: 'Everything FULI keeps is in Memory, for you to confirm, edit or drop. What waits for your decision is in Decisions.',
        go: 'Open Memory',
      },
      projects: {
        title: 'Each project has a lead',
        text: 'One FLA leads each project and remembers it.',
        go: 'Open Projects',
      },
      roundtable: {
        title: 'FLAs meet at the Roundtable',
        text: 'FLAs talk to each other at the Roundtable, whichever client each works in. You can leave them a message there too.',
        go: 'Open the Roundtable',
      },
    },
  },
} as const
