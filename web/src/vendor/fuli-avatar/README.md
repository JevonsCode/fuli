# Pinned FULI avatar renderer

`avatar.js` is an unmodified copy of `dist/avatar.js` from
[JevonsCode/fuli-avatar](https://github.com/JevonsCode/fuli-avatar/blob/8cc51fdbfefd1ca26b08e88d1f3474dbcf8430b2/dist/avatar.js),
commit `8cc51fdbfefd1ca26b08e88d1f3474dbcf8430b2`, package 0.3.0, renderer VERSION 3.
Source SHA-256: `73dbb1d815410ef0b506efb24b0d57550097c657dcbe677c0d9b53332b611b3e`.
Created for JevonsCode's FULI project; incorporated at the owner's request.
The upstream snapshot has no standalone license file; this attribution does not invent one.

The local declaration exposes the entry point FULI consumes. The renderer is bundled
with the console: no CDN, remote image request, runtime dependency, or npm release is needed.
Keep this snapshot pinned: changing the renderer's version changes existing portraits.
Any upgrade must explicitly review that identity change and update the provenance and tests.
