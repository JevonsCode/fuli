<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/svg/lockup/fuli-lockup-bilingual-horizontal-dark.svg" />
    <img src="brand/svg/lockup/fuli-lockup-bilingual-horizontal.svg" alt="FULI 复利 logo" width="200" />
  </picture>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/readme/hero-en-dark.webp" />
    <img src="docs/readme/hero-en.webp" alt="FULI 复利: your AI tools share one memory of you and your projects" width="800" />
  </picture>
</p>

<h3 align="center">Automate everything that can be automated, and hand the execution to your FLAs. You make the calls and lead the way: take your FLA crew through the hard parts, or go grab a coffee and enjoy the compound interest of your own experience.</h3>

<p align="center"><sub>Project profiles and FLA hiring run on their own if you'd rather not think about them; your only job is to set the direction. FLAs carry context and tools across every Agent client, and both top-tier and lighter models pull their weight here.</sub></p>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a> · <a href="https://有点.意思.com/fuli/">Website</a> · <a href="https://github.com/JevonsCode/fuli/releases/latest">Download</a>
</p>

<p align="center">
  <a href="https://github.com/JevonsCode/fuli/releases/latest"><img src="https://img.shields.io/github/v/release/JevonsCode/fuli?style=flat&label=desktop" alt="latest release" /></a>
  <a href="https://www.npmjs.com/package/fuli-context"><img src="https://img.shields.io/npm/v/fuli-context?style=flat&logo=npm&label=fuli-context" alt="npm version" /></a>
  <a href="https://github.com/JevonsCode/fuli/releases"><img src="https://img.shields.io/github/downloads/JevonsCode/fuli/total?style=flat&label=desktop%20downloads" alt="desktop downloads" /></a>
  <a href="https://www.npmjs.com/package/fuli-context"><img src="https://img.shields.io/npm/dm/fuli-context?style=flat&label=npm%20downloads" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/fuli-context?style=flat" alt="license" /></a>
</p>

FULI runs on your own computer and gives every AI coding Agent the same memory: your taste, your
preferences and the facts of each project. Claude Code, Codex, OpenCode and other clients share it.
Each task gets only the small slice it needs. FULI (复利) is Chinese for compound interest: what you
teach an Agent today keeps paying off.

## What FULI does

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/readme/card-memory-en.webp" alt="Claude Code, Codex and OpenCode connected to one FULI" width="460" />
      <h3>One memory for every client</h3>
      Connect Claude Code, Codex, OpenCode or Cursor with one click. A rule you stated in one of them is there in the others.
    </td>
    <td width="50%" valign="top">
      <img src="docs/readme/card-team-en.webp" alt="Three FLAs review a fix together in the roundtable" width="460" />
      <h3>A team of FLAs, talking at a roundtable</h3>
      Each project gets a lead Agent (an FLA) with a name, a job and its own working memory; several FLAs form a group when the work needs it. They review, test and hand work over to each other in the roundtable, and you can read every turn.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/readme/card-tonborg-en.webp" alt="Knowledge waiting to be confirmed, with Tonborg's switch" width="460" />
      <h3>Tonborg confirms for you</h3>
      New knowledge waits for a yes. Switch on Tonborg and it confirms everyday items by your preferences, asks you when it is unsure, writes down each reason, and learns from a thumbs up or down.
    </td>
    <td width="50%" valign="top">
      <img src="docs/readme/card-tokens-en.webp" alt="Tokens per successful task: 0.81 times with FULI" width="460" />
      <h3>Fewer tokens per finished task</h3>
      Measured for the upcoming 0.25.0: a successful task with FULI takes 0.81× the tokens of the same task without it, and 70 of 72 tasks pass. The saving comes from facts that live in your words, not in the code.
    </td>
  </tr>
</table>

Four FLAs come built in: **Jefa** runs the task board, **Bole** hires and staffs, **Tonborg** confirms
and recommends, and **Astro** takes conversations that belong to no project yet.

## How it works

```mermaid
flowchart LR
    U[You] -->|ask inside a project| A[Agent client]
    A -->|task starts| F[FULI on your computer]
    F -->|preferences and a small recall| A
    A -->|look up more if needed| F
    A -->|write back what is reusable| F
```

A task starts with the preferences in effect and a few related facts. The Agent looks up the rest
when it needs it, and at the end writes back only what the next task can reuse.

## Install

**Desktop client (recommended).** Download from the [latest release](https://github.com/JevonsCode/fuli/releases/latest):

| System | File |
| --- | --- |
| Windows | `FULI-Setup-<version>.exe`. No terminal and no administrator rights. |
| macOS (Apple silicon, 13.5 or later) | `fuli-macos-arm64-<version>.dmg`. Drag FULI onto Applications. |

On first launch FULI finds the AI clients on this computer and connects each with one click. The
installers are not signed yet, so each system holds FULI back once; [Install and run](docs/install.md)
shows the two clicks that let it through.

**Servers, VMs and the cloud.** Without a desktop, and on Intel Macs and Linux, install with npm
(Node.js 24.12 or later):

```bash
npm install --global fuli-context
fuli setup
fuli open
```

`fuli setup` shows its plan and changes nothing until you confirm.

## The console

<p align="center">
  <img src="docs/readme/console-en.webp" alt="The FULI console: a task in review, a question waiting for you and the FLAs at work" width="800" />
</p>

The console opens on what matters now: questions waiting for you, the FLAs at work and what they
finished. Everything runs on `127.0.0.1`; there is no account and no sign-in.

## FAQ

<details>
<summary><b>Where is my data?</b></summary>

On your computer. Your personal graph and conversation records stay local. External knowledge
(Notion, Lark, MCP or RAG sources) is read-only: FULI never writes back.
</details>

<details>
<summary><b>Which clients work with FULI?</b></summary>

Claude Code, Codex, OpenCode, Cursor and Claude Desktop connect from the console with one click.
Other MCP clients run `fuli connect` for a standard configuration.
</details>

<details>
<summary><b>How does FULI save tokens?</b></summary>

A session starts with only the preferences in effect and a few related facts; the Agent looks up
the rest when it needs it. Facts that only you know, such as a sandbox URL you mentioned once,
come back later without a search through the code. The numbers are in the
[benchmark](FULI_ALIGNMENT_BENCHMARK.md) (section 8.9.4).
</details>

<details>
<summary><b>Who decides what FULI keeps?</b></summary>

You do: AI looks things up and does the work, and humans retain final authority. Each task ends
with one check that keeps only reusable knowledge. A preference an Agent guessed counts once you,
or Tonborg within the autonomy you set, confirm it. Older answers stay in the history with their
source and reason.
</details>

## Learn more

| Topic | Read |
| --- | --- |
| Install details, CLI commands, ports | [Install and run](docs/install.md) |
| Principles and what is stored where | [How FULI works](docs/how-it-works.md) |
| Connecting each client | [Connect a client](docs/client-connections.md) |
| Skills, hooks and MCP tools | [Agent integrations](docs/agent-tools.md) |
| Notion, Lark and other knowledge bases | [External knowledge](docs/external-knowledge.md) |
| Tonborg and autonomy | [Judgment and autonomy](docs/judgment-and-autonomy.md) |
| The roundtable | [Roundtable](docs/agent-roundtable.md) |
| What is proven so far | [Capabilities and limits](docs/capabilities-and-limits.md) · [Measured report](https://有点.意思.com/fuli/report/en/) |
| Running the source | [Develop and verify](docs/development.md) · [Contributing](CONTRIBUTING.md) |

The FULI mark and wordmarks come from the [FULI 复利 brand system](https://www.figma.com/community/file/1698659778015746085); see [`brand/README.md`](brand/README.md).
Licensed under [Apache-2.0](LICENSE).
