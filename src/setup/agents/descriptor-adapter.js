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
    // A writer whose client format picks between files or needs its version refines its target.
    target: (environment) => writer.target
      ? writer.target(pack, packTarget(pack, environment), environment) : packTarget(pack, environment),
    connect(agent, context, { connectConfig = (target, settings) => writer.connect(pack, target, settings) } = {}) {
      return connectConfig(agent, context);
    },
    disconnect(agent, { disconnectConfig = writer.disconnect } = {}) {
      return disconnectConfig(agent);
    }
  });
}

// Where the pack's files and Skills are; which clients are installed is
// agent-installer's answer (src/agent-kits/client-detection.js).
function packTarget(pack, { env, homeDir, pathApi }) {
  const { clientHome: home, files, skillsRoot } = pack.detection;
  const override = home.envOverride ? env[home.envOverride] : undefined;
  const base = home.envBase ? env[home.envBase] : undefined;
  const clientHome = typeof override === 'string' && override.trim() ? override
    : typeof base === 'string' && base.trim() ? pathApi.join(base, ...home.path.slice(1))
      : pathApi.join(homeDir, ...home.path);
  const bases = { homeDir, clientHome };
  const resolve = ({ from, path }) => pathApi.join(bases[from], ...path);
  const paths = Object.fromEntries(CLIENT_FILE_KEYS.filter((key) => files[key]).map((key) => [key, resolve(files[key])]));
  const skills = resolve(skillsRoot);
  return {
    id: pack.id,
    label: pack.label,
    command: pack.command,
    ...paths,
    ...Object.fromEntries(Object.entries(SKILLS).map(([field, name]) => [field, pathApi.join(skills, name)])),
    reviewSkillPath: pathApi.join(skills, REVIEW_SKILL),
    reviewSkillTrigger: { ...pack.commandSkills.review },
    ...(pack.commandSkills.sessionCommand ? { sessionCommandSkillPath: pathApi.join(skills, SESSION_COMMAND_SKILL) } : {})
  };
}
