// The Node side of graph-provider/fuli_graph/name_identity.py, for names
// people type that a Node-side store keys on. The same rule: identityKey
// applies NFKC (full-width and compatibility forms), lowercases without
// aggressive folding, drops a BOM or zero-width space pasted in, and collapses
// every run of whitespace or line breaks to one space. It never strips
// punctuation, accents, ZWJ sequences or non-BMP characters. Applying it
// again changes nothing.

const INVISIBLE = /[﻿​]/g;
// NFKC and lowercasing settle within two passes; the bound only stops a
// pathological input from looping.
const MAX_PASSES = 4;

const collapsed = (value) => value.replace(INVISIBLE, '').split(/\s+/).filter(Boolean).join(' ');

// The writer's own characters, composed, with spacing tidied.
export function displayName(value) {
  return collapsed(String(value).normalize('NFC'));
}

export function identityKey(value) {
  let key = String(value);
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const normalized = collapsed(key.normalize('NFKC').toLowerCase());
    if (normalized === key) break;
    key = normalized;
  }
  return key;
}
