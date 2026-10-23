import { pathToFileURL } from 'node:url';

// The first module of an app process the trusted runner starts
// (trusted-runner.js): it ties the app to its FULI host and then loads the
// app's service entry. The host holds the other end of stdin; when that FULI
// process exits, however it exits, the pipe closes and the app ends with it.
// The pipe does not keep an app alive that would otherwise finish. Trusted
// app code can undo this; it is a lifetime tie, not a fence.
const [entry] = process.argv.slice(2);
const end = () => process.exit(0);
process.stdin.on('end', end);
process.stdin.on('error', end);
process.stdin.resume();
process.stdin.unref?.();
await import(pathToFileURL(entry).href);
