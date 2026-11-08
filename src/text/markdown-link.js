// A Markdown link that every chat client renders as a link. Some clients (the Claude desktop
// app among them, seen 11-08) show `[text](<url>)` as plain text, so the URL goes bare
// whenever it is safe there. Only a URL with whitespace, angle brackets or parentheses
// keeps the angle-bracket form, which CommonMark needs for those characters.
const NEEDS_ANGLE = /[\s<>()]/;

export function markdownLink(label, url) {
  const target = String(url);
  return NEEDS_ANGLE.test(target)
    ? `[${label}](<${target.replace(/[<>\s]/g, encodeURIComponent)}>)`
    : `[${label}](${target})`;
}
