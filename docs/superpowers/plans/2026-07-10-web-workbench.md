# Web Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local web workbench so non-developer users can inspect spaces, facts, timelines, candidates, and add new episodes without using the CLI.

**Architecture:** Add a dependency-free Node HTTP server that serves JSON APIs and static frontend files. Keep all product logic in existing services (`FileStore`, `IngestionService`, `ContextRouter`) so the web layer is only a surface over the same MVP core.

**Tech Stack:** Node.js 24+, plain JavaScript, `node:test`, static HTML/CSS/JS.

---

## Files

- Create: `src/server.js`  
  Local HTTP server, API routes, static file serving.

- Create: `test/server.test.js`  
  API tests for state, space creation, subscription, remember, and search.

- Create: `web/index.html`  
  Workbench shell.

- Create: `web/styles.css`  
  Quiet operational UI styling.

- Create: `web/app.js`  
  Frontend state loading, rendering, forms, and search interactions.

- Modify: `package.json`  
  Add `start` script.

- Modify: `README.md`  
  Add web workbench run command.

## Tasks

- [ ] Write failing API tests in `test/server.test.js`.
- [ ] Implement `src/server.js` until API tests pass.
- [ ] Add static workbench files under `web/`.
- [ ] Add `npm start` script and README usage.
- [ ] Run `node --test`.
- [ ] Start local server and verify the page loads.
