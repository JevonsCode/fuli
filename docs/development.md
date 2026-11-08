# Develop and verify FULI

English · [简体中文](development.zh-CN.md) · [README](../README.md)

Benchmarks, acceptance runbooks and the commands that test the source.

## Acceptance and development

- [Alignment Benchmark](../FULI_ALIGNMENT_BENCHMARK.md)
- [Token and accuracy report](https://xn--8ovp9s.xn--m8txu.com/fuli/report/en/): measured token use and recall accuracy, with method, model, client, date and what is not measured yet
- [Chinese acceptance index](../acceptance/README.md)
- [Knowledge retrieval and confirmation diagrams](../acceptance/知识检索与确认流程图.md)
- [Read-only external-knowledge architecture](external-knowledge-architecture.md)

```bash
npm install
npm test
npm run test:package
npm run test:external-knowledge:live
```

The external-knowledge live test temporarily downloads two public official documentation
repositories, validates read-only synchronization and retrieval, then removes the complete
temporary directory. It is network-dependent and is not part of the default test suite.

Provider validation:

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install "./graph-provider[dev]"
python -m compileall -q graph-provider/fuli_graph
python -m pytest -q graph-provider/tests
docker compose -f compose.graphiti.yml config --quiet
```

`npm run test:package` builds the web UI, creates a real npm tarball, installs it into an isolated
global prefix, and verifies `fuli` / `fl`, version output, help output, and the packaged UI. Tests,
QA screenshots, and internal design documents are excluded from the npm package.

## Release

Every release ships a few lines on what is new, which the console shows once to the people who
update to it. Write them before tagging, in `src/whats-new/lines/<version>.json`:

```json
{ "version": "0.26.0", "zh": ["一两句用户会注意到的变化，轻松一点。"], "en": ["What people will notice, in a light line or two."] }
```

- 1 to 5 lines per language, each at most 100 characters. The first line is the notice's text;
  「查看详情」 shows all of them and links to the GitHub release.
- What users notice, a little funny: no tests, CI or item-by-item list.
- `node scripts/whats-new-lines.js --release` checks them; the release workflow runs it and
  stops a release whose version has no lines.
