// A bounded Codex judgment run: ephemeral, read-only, without user config, rules or shell.
export const judgmentClient = Object.freeze({
  args({ cwd, quality }) {
    return ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--skip-git-repo-check', '--sandbox', 'read-only', '-C', cwd,
      '-c', 'project_doc_max_bytes=0', '-c', 'features.shell_tool=false',
      '-c', `model_reasoning_effort="${quality === 'economy' ? 'low' : quality === 'balanced' ? 'medium' : 'high'}"`, '-'];
  },
});
