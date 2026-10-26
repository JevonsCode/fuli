// The SHA-256 of native/win32/fuli-win-helper.exe as GitHub Actions built it
// for this package. The release workflow builds the helper on windows-latest
// and writes its digest here before publishing (scripts/pin-win-helper.js); a
// source checkout has no helper and no pin, so Windows Hello is unavailable there.
// The helper is not Authenticode-signed: this digest is its only integrity check.
export const WIN_HELPER_SHA256 = null;
