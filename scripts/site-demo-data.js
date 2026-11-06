// The website screenshots' synthetic demo: projects, FLAs, tasks, knowledge and a request for the
// person, written through the console's own API into a throwaway FULI (scripts/site-screenshots.js),
// and the console screens to capture. Every name and fact here is made up. Writing is idempotent:
// FLAs are matched by name, tasks and requests carry fixed idempotency keys.
import { randomUUID } from 'node:crypto';

const PROJECTS = [
  { id: 'shop-web', purpose: 'Storefront web app: catalog, cart and checkout.', scope: 'The web front end and its API client.' },
  { id: 'orbit-ledger', purpose: 'Billing ledger service behind checkout.', scope: 'Ledger API, rates client and settlement jobs.' },
  { id: 'docs-site', purpose: 'Public product documentation.', scope: 'Guides, API reference and release notes.' },
];

const AGENTS = [
  { project: 'shop-web', name: 'Milo Reed', role: 'lead', responsibility: 'Leads shop-web: front-end features, fixes and releases.', capabilities: ['vue', 'typescript', 'testing'], emoji: '🛠️' },
  { project: 'shop-web', name: 'Nova Lane', role: 'engineering', responsibility: 'Reviews shop-web changes before they merge.', capabilities: ['code review', 'accessibility'], emoji: '🔍' },
  { project: 'shop-web', name: 'Ada Brooks', role: 'testing', responsibility: 'Writes and runs shop-web end-to-end tests.', capabilities: ['playwright', 'qa'], emoji: '🧪' },
  { project: 'orbit-ledger', name: 'Kai Moreno', role: 'lead', responsibility: 'Leads orbit-ledger: ledger API and settlement jobs.', capabilities: ['node', 'postgres'], emoji: '📒' },
  { project: 'docs-site', name: 'Iris Chen', role: 'documentation', responsibility: 'Keeps docs-site accurate after each release.', capabilities: ['writing', 'markdown'], emoji: '✍️' },
];

// status: the state the demo shows; plan steps name their FLA.
const TASKS = [
  { key: 'remember-me', project: 'shop-web', lead: 'Milo Reed', with: ['Nova Lane'], status: 'running', source: 'claude_code',
    title: 'Fix remember-me after token refresh', objective: 'Keep the remember flag when the session token refreshes; add two tests.',
    summary: 'Found it: session.ts overwrites the remember flag on refresh.',
    plan: [['Reproduce the refresh bug', 'completed', 'Milo Reed'], ['Keep the flag in session.ts', 'in_progress', 'Milo Reed'],
      ['Add two tests', 'pending', 'Milo Reed'], ['Review the change', 'pending', 'Nova Lane']] },
  { key: 'guest-checkout', project: 'shop-web', lead: 'Ada Brooks', with: [], status: 'running', source: 'codex',
    title: 'E2E: guest checkout with a saved cart', objective: 'Cover guest checkout when a saved cart is restored.',
    summary: 'Two of three flows covered; the restore flow is next.',
    plan: [['Guest checkout, empty cart', 'completed', 'Ada Brooks'], ['Guest checkout, saved cart', 'completed', 'Ada Brooks'], ['Restore after sign-in', 'in_progress', 'Ada Brooks']] },
  { key: 'rates-retry', project: 'orbit-ledger', lead: 'Kai Moreno', with: [], status: 'awaiting_review', source: 'codex',
    title: 'Rates client: 3 retries, fixed 250 ms', objective: 'Retry 5xx three times with a fixed 250 ms wait; never retry 4xx.',
    summary: 'Retries are now 3 × 250 ms and 4xx is never retried; the suite passes.' },
  { key: 'release-notes', project: 'docs-site', lead: 'Iris Chen', with: [], status: 'running', source: 'opencode',
    title: 'Release notes for 2.4', objective: 'Summarise the 2.4 changes for users.',
    summary: 'Drafting the checkout and ledger sections.' },
];

const REQUESTS = [
  { key: 'beta-or-wait', project: 'shop-web', agent: 'Milo Reed', task: 'remember-me', kind: 'question',
    title: 'Ship the remember-me fix in beta 2.4.1, or wait for 2.5?',
    detail: 'The fix is small and tested. 2.4.1 ships it this week; 2.5 bundles it with the cart changes in two weeks.',
    requestedAction: 'Pick when to ship the fix.', options: ['Ship in 2.4.1', 'Wait for 2.5'] },
];

const KNOWLEDGE = [
  { project: 'orbit-ledger', key: 'staging-port', name: 'Staging health check port', type: 'ProjectFact', summary: 'The staging health check runs on port 7413 (it moved from 7400).' },
  { project: 'orbit-ledger', key: 'rates-retry', name: 'Rates client retry policy', type: 'ProjectFact', summary: 'Rates client: 3 tries, a fixed 250 ms wait, never retry 4xx.' },
  { project: 'shop-web', key: 'checkout-codes', name: 'Checkout error codes', type: 'ProjectFact', summary: 'Checkout errors use CHK- plus four digits; take the next free number.' },
  { project: 'shop-web', key: 'copy-style', name: 'UI copy style', type: 'Preference', summary: 'Keep UI copy short; no exclamation marks.' },
  // Waiting for the person: proposed in a session, not yet confirmed.
  { project: 'orbit-ledger', key: 'settlement-day', name: 'Settlement day', type: 'ProjectFact', summary: 'Settlement uses the Singapore date (UTC+8), not the UTC date.', pending: true },
  { project: 'shop-web', key: 'cart-badge', name: 'Cart badge count', type: 'ProjectFact', summary: 'The cart badge counts items, not lines.', pending: true },
];

async function call(origin, method, path, body) {
  const response = await fetch(origin + path, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const listOf = (value, key) => (Array.isArray(value) ? value : value?.[key] ?? value?.items ?? []);

async function writeProjects(origin, space) {
  for (const project of PROJECTS) {
    await call(origin, 'PUT', '/api/personal-projects', { personalSpaceId: space, projectId: project.id,
      profile: { name: project.id, purpose: project.purpose, scope: project.scope, lifecycle: 'active' } });
  }
}

async function writeAgents(origin, space) {
  const ids = new Map();
  for (const agent of AGENTS) {
    const query = `/api/project-agents?personalSpaceId=${space}&personalProjectId=${agent.project}`;
    const existing = listOf(await call(origin, 'GET', query), 'agents').find((item) => (item.profile?.name ?? item.name) === agent.name);
    const agentId = existing?.agentId ?? existing?.agent_id ?? randomUUID();
    await call(origin, 'PUT', '/api/project-agents', { personalSpaceId: space, personalProjectId: agent.project, agentId,
      profile: { name: agent.name, displayName: agent.name, responsibility: agent.responsibility, capabilities: agent.capabilities, occupationEmoji: agent.emoji },
      ...(existing ? {} : { occupation: { role: agent.role } }) });
    ids.set(agent.name, agentId);
  }
  return ids;
}

// One lead per project, members beside it (the project team).
async function writeTeams(origin, space, agents) {
  for (const project of PROJECTS) {
    const members = AGENTS.filter((agent) => agent.project === project.id);
    const lead = members.find((agent) => agent.role === 'lead') ?? members[0];
    const query = `/api/project-agent-coordination-policy?personalSpaceId=${space}&personalProjectId=${project.id}`;
    const current = await call(origin, 'GET', query).catch(() => null);
    await call(origin, 'PATCH', '/api/project-agent-coordination-policy', { personalSpaceId: space, personalProjectId: project.id,
      teamLeadAgentId: agents.get(lead.name), teamMemberAgentIds: members.filter((agent) => agent !== lead).map((agent) => agents.get(agent.name)),
      expectedUpdatedAt: current?.updatedAt ?? current?.policy?.updatedAt ?? null });
  }
}

async function writeTasks(origin, space, agents) {
  const ids = new Map();
  for (const task of TASKS) {
    const { task: saved } = await call(origin, 'POST', '/api/project-agent-tasks', { personalSpaceId: space, personalProjectId: task.project,
      idempotencyKey: `site-demo-${task.key}`, title: task.title, objective: task.objective, workKind: 'implementation',
      routingReason: 'Demo task for the website screenshots.', leadAgentId: agents.get(task.lead),
      collaboratorAgentIds: task.with.map((name) => agents.get(name)), start: false });
    ids.set(task.key, saved.taskId);
    if (saved.status === task.status) continue;
    await call(origin, 'POST', '/api/project-agent-activity', { personalSpaceId: space, personalProjectId: task.project,
      taskId: saved.taskId, idempotencyKey: `site-demo-${task.key}-${task.status}`, expectedRevision: saved.revision,
      status: task.status, summary: task.summary, agentId: agents.get(task.lead), actorKind: 'agent', sourceApplication: task.source,
      ...(task.plan ? { executionPlan: { steps: task.plan.map(([title, status, name], i) => ({ id: `s${i + 1}`, title, status, agentId: agents.get(name) })) } } : {}) });
  }
  return ids;
}

async function writeRequests(origin, space, agents, tasks) {
  for (const request of REQUESTS) {
    await call(origin, 'POST', '/api/agent-attention', { personalSpaceId: space, personalProjectId: request.project,
      agentId: agents.get(request.agent), taskId: tasks.get(request.task), idempotencyKey: `site-demo-${request.key}`,
      kind: request.kind, title: request.title, detail: request.detail, requestedAction: request.requestedAction, options: request.options });
  }
}

async function writeKnowledge(origin, space) {
  await call(origin, 'PATCH', '/api/capture-policy', { enabled: true, projectMode: 'all' });
  const now = new Date().toISOString();
  for (const project of PROJECTS) {
    const items = KNOWLEDGE.filter((item) => item.project === project.id);
    if (!items.length) continue;
    await call(origin, 'POST', '/api/capture', { targetKind: 'personal', spaceId: space, personalProjectId: project.id,
      sessionId: `site-demo-${project.id}`, idempotencyKey: `site-demo-knowledge-${project.id}-v2`, name: `${project.id} decisions`,
      sourceKind: 'conversation', sourceDescription: 'Synthetic demo conversation', sourceApplication: 'claude_code', referenceTime: now,
      entities: items.map((item) => ({ key: item.key, name: item.name, type: item.type, summary: item.summary,
        originQuadrant: 'known_known', confirmationStatus: item.pending ? 'pending' : 'confirmed',
        confirmationBasis: { existenceReason: 'Stated in the demo conversation.', quadrantReason: 'Said directly in the conversation.',
          proposedBy: { kind: 'agent', label: 'Demo' }, ...(item.pending ? {} : { confirmedBy: { kind: 'user', label: null }, confirmedAt: now }) } })),
      relationships: [] });
  }
}

// The project overview opens on its settings; the team is the part this screen is for.
async function showTeam(page) {
  await page.evaluate(() => {
    const heading = [...document.querySelectorAll('h2, h3')].find((node) => /^(项目团队|Project team)$/.test(node.textContent.trim()));
    // The whole team card at the bottom of the view, the project's name and settings above it.
    (heading?.closest('section, article, .card') ?? heading)?.scrollIntoView({ block: 'end' });
  });
  await page.waitForTimeout(600);
}

async function connectAll(page) {
  const button = page.getByRole('button', { name: /^(一键接入|Connect all)$/ });
  // Once every client is connected the button is disabled: nothing left to do.
  if (await button.count() && await button.first().isEnabled()) {
    await button.first().click();
    await page.waitForTimeout(8000);
  }
  await page.evaluate(() => {
    for (const node of document.querySelectorAll('pre, code, textarea')) {
      // Any absolute path up to its src/ or bin/ part: /home/…, /mnt/…, /Users/…, C:\….
      const neutral = (text) => text.replace(/(?:\/home|\/mnt|\/Users|[A-Z]:\\)[^"\s]*?([\\/](?:src|bin)[\\/][^"\s]+)/g, '~/FULI$1');
      if ('value' in node && node.tagName === 'TEXTAREA') node.value = neutral(node.value);
      else node.textContent = neutral(node.textContent);
    }
  });
}

export async function seedDemo(origin, { write }) {
  const state = await call(origin, 'GET', '/api/state');
  const space = state.activePersonalSpaceId;
  let agents = new Map();
  if (!write) {
    for (const agent of AGENTS) {
      const listed = listOf(await call(origin, 'GET', `/api/project-agents?personalSpaceId=${space}&personalProjectId=${agent.project}`), 'agents');
      const found = listed.find((item) => (item.profile?.name ?? item.name) === agent.name);
      if (found) agents.set(agent.name, found.agentId ?? found.agent_id);
    }
  }
  if (write) {
    await writeProjects(origin, space);
    agents = await writeAgents(origin, space);
    await writeTeams(origin, space, agents);
    const tasks = await writeTasks(origin, space, agents);
    await writeRequests(origin, space, agents, tasks);
    await writeKnowledge(origin, space);
  }
  const project = (id, mode) => `/personal/${space}/projects/${id}/${mode}`;
  return { space, agents, screens: [
    // A first open: the person has not finished getting started yet.
    { name: 'first-run', path: '/', firstRun: true },
    // Connected: what the step shows. The manual-config block names this machine's paths, so
    // they read as a neutral install folder instead.
    { name: 'connections', path: '/settings?tab=clients', prepare: connectAll },
    { name: 'workbench', path: '/' },
    { name: 'inbox', path: '/inbox' },
    { name: 'agent', path: `/agents/${space}/${agents.get('Milo Reed')}` },
    { name: 'models', path: '/models' },
    { name: 'project', path: project('shop-web', 'overview'), prepare: showTeam },
    { name: 'knowledge', path: project('orbit-ledger', 'directory') },
  ] };
}
