export const aboutMessages = {
  'zh-CN': {
    aria: 'FULI 说明',
    labelsAria: '知识标签说明',
    philosophy: {
      title: '对话会结束，方法应该留下',
      intro: 'FULI 希望人在与 Agent 的协作中，逐渐沉淀自己的工作流、工作态度、工作个性、判断方式与个人品味。它们不只属于工作，也可以来自生活、兴趣和长期形成的习惯。',
      support: '目标不是保存每一句对话，而是让真正稳定、能够再次发挥作用的经验留下来，并随着一次次使用形成个人项目与方法论。',
      capture: {
        index: '01',
        title: '从真实协作中沉淀',
        description: '偏好、步骤、标准、边界和有效做法来自真实任务；Agent 可以提炼，用户负责确认、纠正或拒绝。',
      },
      project: {
        index: '02',
        title: '让个人项目逐渐成形',
        description: '项目可以从聊天、文档、仓库、文件或一句说明开始。Agent 可以建议归属，但项目由用户指定，归错的知识也可以重新调整。',
      },
      review: {
        index: '03',
        title: '周期回顾，而不是无限堆积',
        description: '在合适的周期回顾知识，确认内容、处理冲突、整理分类并识别过期信息；Agent 可以在有余量的周期里，利用剩余 token 辅助完成这些整理。',
      },
      reuse: {
        index: '04',
        title: '跨 Agent 复用自己的方法',
        description: '重复出现的流程不必向每个 Agent 重新说明。稳定的方法可以成为全局工作流，也可以只留在特定项目，在不同工具和场景中继续复用。',
      },
      boundariesTitle: '始终保留的边界',
      local: {
        title: '本机优先',
        description: '个人项目与会话沉淀默认留在本机，只有用户明确提交时才进入公共流程。',
      },
      authority: {
        title: '用户决定',
        description: 'Agent 可以建议、整理和发现，但项目归属、内容确认与最终取舍由用户决定。',
      },
      scope: {
        title: '按范围复用',
        description: '通用方法可以跨项目使用；项目特有知识不会因为相似就自动进入另一个项目。',
      },
    },
    labelsIntro: {
      title: '标签体系',
      description: '同一条知识可以同时拥有偏好类型、发现来源和确认状态；三个维度各自回答不同的问题。',
    },
    credits: {
      title: '开源致谢',
      description: 'FULI 建立在这些开源项目之上。',
      sourceNote: '标识通过各项目官网或官方 GitHub 资源加载；项目名称、标识和许可证归各自社区与权利人所有。',
      roles: {
        vue: '界面框架',
        vite: '构建工具',
        pinia: '状态管理',
        d3: '图谱可视化',
        vitest: '前端测试',
        hono: 'HTTP 运行层',
        neo4j: '图数据库',
        zod: '结构校验',
        fastapi: 'Provider 服务',
        graphiti: '时序知识图谱',
        mcp: 'Agent 工具协议',
      },
      finale: '让方法与项目，在每一次协作中继续生长。',
    },
    dimensions: {
      profile: {
        title: '偏好类型',
        question: '这是什么偏好',
        timing: '写入偏好时归类',
      },
      origin: {
        title: '发现来源',
        question: '最初怎么发现',
        timing: '首次写入后保留',
      },
      confirmation: {
        title: '确认状态',
        question: '目前由谁确认',
        timing: '随确认与使用证据变化',
      },
    },
    sections: {
      profile: {
        index: '01',
        title: '偏好类型',
        meta: '只用于个人偏好',
      },
      origin: {
        index: '02',
        title: '发现来源',
        meta: '所有知识都记录',
      },
      confirmation: {
        index: '03',
        title: '确认状态',
        meta: '所有知识都记录',
      },
    },
    profiles: {
      taste: {
        label: '品味',
        short: '偏爱的结果或风格',
        description: '界面、文案、产品、架构或工程结果中，用户明确喜欢或排斥的方向。',
      },
      personality: {
        label: '个性',
        short: '稳定的自我描述',
        description: '用户明确表达的长期工作或协作特点；Agent 从行为推断时先保持待确认。',
      },
      judgment: {
        label: '判断偏好',
        short: '面对取舍时怎么决定',
        description: '决策条件、优先级、风险倾向，以及在特定情况下需要遵守的边界。',
      },
    },
    quadrants: {
      awareness: '意识程度',
      aware: '已意识',
      unaware: '未意识',
      mastery: '掌握程度',
      mastered: '已掌握',
      unmastered: '未掌握',
      knownUnknown: {
        label: '明确问题',
        coordinate: '已意识 · 未掌握',
        description: '已经提出，但仍没有答案的问题或取舍。',
      },
      knownKnown: {
        label: '明确表达',
        coordinate: '已意识 · 已掌握',
        description: '被用户、文档或其他来源直接表达的知识、结论或要求。',
      },
      unknownUnknown: {
        label: '盲点探索',
        coordinate: '未意识 · 未掌握',
        description: '在开放探索中才暴露出来、仍需判断的潜在盲点。',
      },
      unknownKnown: {
        label: '隐性提炼',
        coordinate: '未意识 · 已掌握',
        description: '从行为、示例、原型或反馈中提炼出的隐性知识。',
      },
      immutable: '发现来源不是可信度。后续确认不会改变它。',
      unclassified: '“待分类”不是第五象限，只表示旧内容还没有补充发现来源。',
    },
    statuses: {
      entryCondition: '进入条件',
      pending: {
        label: '待确认',
        description: 'Agent 提出的内容、推断内容，或缺少确认人和确认时间的旧数据。',
        rule: '写入时没有有效的用户或权威来源确认',
      },
      agentConfirmed: {
        label: 'Agent 已确认',
        description: '内容在多个独立任务中实际影响了回答、实现或决策，权重仍低于人工确认。',
        rule: '至少 5 次有效使用、覆盖 3 个任务，并且没有未解决冲突',
      },
      confirmed: {
        label: '已确认',
        description: '由用户或权威来源明确确认，具有最高确认权重。',
        rule: '记录确认人、确认时间和确认依据',
      },
      usageBoundary: '检索、查看、进入上下文和自动注入都不算有效使用。',
      resetBoundary: '内容或分类发生变化后，会回到待确认；同一次修改若由用户或权威来源重新确认则除外。',
    },
    example: {
      title: '三个维度可以同时存在',
      item: 'FULI 保留主标题并减少解释性文案',
      profile: '品味',
      origin: '明确表达',
      status: '已确认',
      description: '它是界面结果偏好，由用户直接表达，并由用户确认。三个标签回答的是三件不同的事。',
    },
    allFilter: '“全部”只是当前筛选条件，不会写入知识，也不是第四种确认状态或第五种偏好类型。',
  },
  'en-US': {
    aria: 'About FULI',
    labelsAria: 'Knowledge label guide',
    philosophy: {
      title: 'Conversations end. Methods should remain.',
      intro: 'FULI helps people gradually retain their workflows, working attitudes, collaboration traits, judgment patterns, and personal taste through real work with Agents. The same idea also applies beyond work—to interests, daily life, and habits formed over time.',
      support: 'The goal is not to preserve every line of a conversation. It is to keep stable experience that can matter again, then let repeated use grow into personal projects and a reusable methodology.',
      capture: {
        index: '01',
        title: 'Learn from real collaboration',
        description: 'Preferences, steps, standards, boundaries, and proven practices come from real tasks. Agents may extract them; users confirm, correct, or reject them.',
      },
      project: {
        index: '02',
        title: 'Let personal projects take shape',
        description: 'A project can begin with a chat, document, repository, file, or a short description. Agents may suggest placement, but users choose the project and can reassign misplaced knowledge.',
      },
      review: {
        index: '03',
        title: 'Review periodically, not endlessly accumulate',
        description: 'At useful intervals, review knowledge, confirm content, resolve conflicts, refine classification, and identify stale information. Agents can use spare token budget to assist with this work.',
      },
      reuse: {
        index: '04',
        title: 'Reuse your method across Agents',
        description: 'A recurring process should not be re-explained to every Agent. Stable methods can become global workflows or stay project-specific, then remain useful across tools and contexts.',
      },
      boundariesTitle: 'Boundaries that remain',
      local: {
        title: 'Local first',
        description: 'Personal projects and conversation-derived knowledge stay on the device by default. They enter a public flow only after an explicit user submission.',
      },
      authority: {
        title: 'User decides',
        description: 'Agents may suggest, organize, and discover; users decide project placement, confirmation, and final trade-offs.',
      },
      scope: {
        title: 'Reuse by scope',
        description: 'General methods may work across projects. Project-specific knowledge never enters another project merely because it looks similar.',
      },
    },
    labelsIntro: {
      title: 'Label system',
      description: 'One item may carry a preference type, discovery source, and confirmation status at the same time. Each dimension answers a different question.',
    },
    credits: {
      title: 'Open-source credits',
      description: 'FULI is built on these open-source projects.',
      sourceNote: 'Marks load from each project’s website or official GitHub resources. Project names, marks, and licenses belong to their respective communities and rights holders.',
      roles: {
        vue: 'Interface framework',
        vite: 'Build tooling',
        pinia: 'State management',
        d3: 'Graph visualization',
        vitest: 'Frontend testing',
        hono: 'HTTP runtime',
        neo4j: 'Graph database',
        zod: 'Schema validation',
        fastapi: 'Provider service',
        graphiti: 'Temporal knowledge graph',
        mcp: 'Agent tool protocol',
      },
      finale: 'Let methods and projects keep growing through every collaboration.',
    },
    dimensions: {
      profile: {
        title: 'Preference type',
        question: 'What kind of preference is it?',
        timing: 'Assigned when a preference is captured',
      },
      origin: {
        title: 'Discovery source',
        question: 'How was it first discovered?',
        timing: 'Preserved after the first capture',
      },
      confirmation: {
        title: 'Confirmation status',
        question: 'Who or what confirms it now?',
        timing: 'Changes with confirmation and usage evidence',
      },
    },
    sections: {
      profile: {
        index: '01',
        title: 'Preference type',
        meta: 'Personal preferences only',
      },
      origin: {
        index: '02',
        title: 'Discovery source',
        meta: 'Recorded for all knowledge',
      },
      confirmation: {
        index: '03',
        title: 'Confirmation status',
        meta: 'Recorded for all knowledge',
      },
    },
    profiles: {
      taste: {
        label: 'Taste',
        short: 'Preferred outcomes or styles',
        description: 'Directions the user explicitly likes or rejects in UI, writing, product, architecture, or engineering outcomes.',
      },
      personality: {
        label: 'Personality',
        short: 'Stable self-description',
        description: 'Long-term working or collaboration traits explicitly described by the user. Agent inference starts as pending.',
      },
      judgment: {
        label: 'Judgment preference',
        short: 'How trade-offs are decided',
        description: 'Decision conditions, priorities, risk posture, and boundaries that apply in specific situations.',
      },
    },
    quadrants: {
      awareness: 'Awareness',
      aware: 'Aware',
      unaware: 'Unaware',
      mastery: 'Mastery',
      mastered: 'Mastered',
      unmastered: 'Not mastered',
      knownUnknown: {
        label: 'Explicit question',
        coordinate: 'Aware · not mastered',
        description: 'A question or trade-off that has been raised but is still unresolved.',
      },
      knownKnown: {
        label: 'Explicit statement',
        coordinate: 'Aware · mastered',
        description: 'Knowledge, conclusions, or requirements directly expressed by a user, document, or other source.',
      },
      unknownUnknown: {
        label: 'Blind-spot exploration',
        coordinate: 'Unaware · not mastered',
        description: 'A potential blind spot surfaced through open exploration and still awaiting judgment.',
      },
      unknownKnown: {
        label: 'Tacit extraction',
        coordinate: 'Unaware · mastered',
        description: 'Tacit knowledge extracted from behavior, examples, prototypes, or feedback.',
      },
      immutable: 'Discovery source is not a truth score. Later confirmation does not change it.',
      unclassified: '“Unclassified” is not a fifth quadrant. It only marks legacy content whose discovery source is missing.',
    },
    statuses: {
      entryCondition: 'Entry condition',
      pending: {
        label: 'Pending',
        description: 'Agent-proposed or inferred content, and legacy data without a confirmer and confirmation time.',
        rule: 'No valid user or authoritative-source confirmation at capture time',
      },
      agentConfirmed: {
        label: 'Agent confirmed',
        description: 'The content materially affected answers, implementation, or decisions across independent tasks. It remains below human confirmation.',
        rule: 'At least 5 qualified uses across 3 tasks, with no unresolved conflict',
      },
      confirmed: {
        label: 'Confirmed',
        description: 'Explicitly confirmed by the user or an authoritative source, with the highest confirmation weight.',
        rule: 'A confirmer, confirmation time, and confirmation basis are recorded',
      },
      usageBoundary: 'Retrieval, viewing, context inclusion, and automatic injection do not count as qualified use.',
      resetBoundary: 'Content or classification changes return an item to pending unless the same revision is reconfirmed by a user or authoritative source.',
    },
    example: {
      title: 'All three dimensions can coexist',
      item: 'FULI keeps concise page titles and removes explanatory copy',
      profile: 'Taste',
      origin: 'Explicit statement',
      status: 'Confirmed',
      description: 'It is a UI outcome preference, directly stated by the user and confirmed by the user. Each label answers a different question.',
    },
    allFilter: '“All” is only the current filter. It is not written to knowledge and is neither a fourth confirmation status nor a fifth preference type.',
  },
} as const
