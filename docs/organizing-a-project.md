# Organising a project (整理)

Astro organises what FULI knows of a project. The first run on a project is
its onboarding: a person who just installed FULI brings in what the project
already has, without typing it in.

## Starting a run

Say one sentence to your own AI, in any connected client, from the project's
folder:

```text
#FLA Astro 整理当前项目
```

A scope may follow it (「…的发布流程」). The project page in the console shows
how much is known (「已了解 7 / 9」) and copies the sentence for you. The run
uses the model of that session; FULI needs no model of its own for it.

## What a run does

- **Fill**: what the project's files and history say that FULI does not have.
  With your yes, also this project's memories in your AI clients, its earlier
  sessions, and connected outside sources. Each is asked about once.
- **Merge** items that say the same thing.
- **Mark** items that are out of date or contradict each other.
- **Tidy** scattered items on one subject into one clear item.

There is no interview. What the AI could not settle comes as one short list
at the end, each line answerable 是 / 否 / 其他, and you may skip it.

Everything a run adds or proposes is pending until you confirm it.

## How complete the picture is

Nine areas measure it: what the project is, its stack, how to run and release
it, conventions, decisions, pitfalls, people, outside systems, and your own
working preferences. Each is known, to confirm, missing, or not applicable.
They are a measure, not a questionnaire.

## Which model

Organising is judgement, so a stronger model does it better. A run says what
it recognises of its model: strong, mid-range, small, or unknown. A small
model only copies what files and records say; it does not merge or judge what
is stale. FULI places a model only when its family leaves no doubt and says
`unknown` otherwise.

## For Agents

`organize_project` reads the coverage and records a run; the steps are in
`skills/operating-fuli` (Organising a project). The console reads
`GET /api/project-organizing`. The store keeps coverage and run counts only;
knowledge is saved through `checkpoint_task_knowledge`.
