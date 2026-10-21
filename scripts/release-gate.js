import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The release gate (rec#17 D-11): publishing fails while the committed
// marker blocks it. Part 2 of the data format migration (confirm, apply and
// recovery) sets formatReleaseGate to "open".
// node scripts/release-gate.js [MARKER_FILE]
const markerPath = process.argv[2] ?? fileURLToPath(new URL('../release-gate.json', import.meta.url));
const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
if (marker.formatReleaseGate !== 'open') {
  console.error(`Release blocked: formatReleaseGate is "${marker.formatReleaseGate}". ${marker.reason ?? ''}`.trim());
  process.exitCode = 1;
}
