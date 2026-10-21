import { CLIENT_FILE_KEYS } from './descriptor-schema.js';
import { CONFIG_WRITERS } from './config-writers.js';

// The packaged Skills every lifecycle client receives, by agent field.
const SKILLS = Object.freeze({
  skillPath: 'capturing-session-knowledge',
  projectSkillPath: 'grilling-project',
  operationSkillPath: 'operating-fuli'
});
const REVIEW_SKILL = 'flreview';
// The person's /fuli start|stop|restart|status (rec#5 C3b), installed only
// where the client turns a Skill into a command (`commandSkills.sessionCommand`).
const SESSION_COMMAND_SKILL = 'fuli';

// The descriptor-backed implementation of the agent adapter port. It has the
// same shape as a code adapter; only the registry knows which one it built.
export function descriptorAdapter(pack) {
  const writer = CONFIG_WRITERS[pack.configWriter];
  if (!writer) throw new TypeError(`Unknown client config writer: ${pack.configWriter}`);
  return Object.freeze({
    id: pack.id,
    detect: (environment) => detectClient(pack, environment),
    connect(agent, context, { connectConfig = (target, settings) => writer.connect(pack, target, settings) } = {}) {
      return connectConfig(agent, context);
    },
    disconnect(agent, { disconnectConfig = writer.disconnect } = {}) {
      return disconnectConfig(agent);
    },
    status: (agent, context, readers) => writer.status(pack, agent, context, readers)
  });
}

function detectClient(pack, { env, homeDir, pathApi, fileExists, commandExists }) {
  const { clientHome: home, files, skillsRoot, availableWhen } = pack.detection;
  const override = home.envOverride ? env[home.envOverride] : undefined;
  const clientHome = typeof override === 'string' && override.trim() ? override : pathApi.join(homeDir, ...home.path);
  const bases = { homeDir, clientHome };
  const resolve = ({ from, path }) => pathApi.join(bases[from], ...path);
  const paths = Object.fromEntries(CLIENT_FILE_KEYS.filter((key) => files[key]).map((key) => [key, resolve(files[key])]));
  const skills = resolve(skillsRoot);
  // Built-in probes only, in the pack's order; the first match decides.
  const available = availableWhen.some((probe) => probe.probe === 'commandOnPath'
    ? Boolean(commandExists(pack.command))
    : Boolean(fileExists(probe.target === 'clientHome' ? clientHome : paths[probe.target])));
  return {
    id: pack.id,
    label: pack.label,
    command: pack.command,
    ...paths,
    ...Object.fromEntries(Object.entries(SKILLS).map(([field, name]) => [field, pathApi.join(skills, name)])),
    available,
    reviewSkillPath: pathApi.join(skills, REVIEW_SKILL),
    reviewSkillTrigger: { ...pack.commandSkills.review },
    ...(pack.commandSkills.sessionCommand ? { sessionCommandSkillPath: pathApi.join(skills, SESSION_COMMAND_SKILL) } : {})
  };
}
