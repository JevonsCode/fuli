// What the person's own AI on a runner is asked to do when this computer runs
// an older FULI than its host (rec issue 144): install exactly the host's
// version — "or newer" would leave this computer ahead of the host and turn
// the notice around — then restart what runs the old copy. It is a prompt
// for an AI, built here rather than in the message catalogue, because it
// names the commands that AI runs; the person never types them.
const PLAIN_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export function runnerUpdatePrompt(hostVersion: string, locale: string): string | null {
  if (!PLAIN_VERSION.test(hostVersion)) return null
  const version = hostVersion.replace(/^v/, '')
  return locale.startsWith('zh')
    ? [
        `帮我把这台电脑上的 FULI 更新到主机的版本 ${version}（正好这个版本，不要更新到别的版本）。`,
        '先告诉我你要运行什么，我同意后再做：',
        `1. npm install --global fuli-context@${version}`,
        '2. fuli restart（重启这台电脑上的 FULI 控制台入口）',
        '3. 告诉我要重启哪些已打开的 AI 客户端会话，它们重开后才用上新版本',
        '最后运行 fuli runner status，把它说的版本告诉我。',
      ].join('\n')
    : [
        `Update FULI on this computer to the host's version, exactly ${version} (not any other version).`,
        'Tell me what you will run first, and go ahead once I agree:',
        `1. npm install --global fuli-context@${version}`,
        "2. fuli restart (restarts this computer's FULI console entry)",
        '3. tell me which open AI client sessions to restart; they use the new version once reopened',
        'Finally run fuli runner status and tell me the versions it reports.',
      ].join('\n')
}
