# Pinned FULI avatar renderer

`avatar.js` is an unmodified copy of `dist/avatar.js` from
[JevonsCode/fuli-avatar](https://github.com/JevonsCode/fuli-avatar/blob/748e390/dist/avatar.js),
release [v0.4.0](https://github.com/JevonsCode/fuli-avatar/releases/tag/v0.4.0), commit `748e390`, renderer VERSION 4
(VERSION 3 stays available byte for byte through `{ version: 3 }`).
Source SHA-256: `6133edcd7c008c657c2e5356b43c35a5ab0ee20d4868aa07394c17d0f9afffb5`.
Created for JevonsCode's FULI project; incorporated at the owner's request.
The upstream snapshot has no standalone license file; this attribution does not invent one.

The local declaration exposes the entry point FULI consumes. The renderer is bundled
with the console: no CDN, remote image request, runtime dependency, or npm release is needed.
Keep this snapshot pinned: changing the renderer's version changes existing portraits.
Any upgrade must explicitly review that identity change and update the provenance and tests.
The 0.4.0 upgrade (rec#11 D-89) was asked for by the owner: every generated portrait now
matches the built-in ones; a person can still re-roll or upload a look per Agent.
