# Pinned FULI avatar renderer

`avatar.js` and `avatar.d.ts` are unmodified copies of `dist/avatar.js` and `dist/avatar.d.ts` from
[JevonsCode/fuli-avatar](https://github.com/JevonsCode/fuli-avatar/blob/93464e7/dist/avatar.js),
release [v0.5.0](https://github.com/JevonsCode/fuli-avatar/releases/tag/v0.5.0), commit `93464e7`, renderer VERSION 5
(VERSION 4 and 3 stay available byte for byte through `{ version: 4 }` and `{ version: 3 }`).
Source SHA-256: `40d961304592feecbbe42f2b17c7e5514c02e56d216d6164770f153e921bfc77`.
Created for JevonsCode's FULI project; incorporated at the owner's request.
The upstream snapshot has no standalone license file; this attribution does not invent one.

The renderer is bundled with the console: no CDN, remote image request, runtime dependency, or npm release is needed.
Keep this snapshot pinned: changing the renderer's version changes existing portraits.
Any upgrade must explicitly review that identity change and update the provenance and tests.
The 0.4.0 upgrade (rec#11 D-89) and the 0.5.0 upgrade (2026-11-01) were asked for by the owner: every generated
portrait follows the latest renderer, animated portraits move unless motion is reduced, and a person can still
re-roll or upload a look per Agent.
