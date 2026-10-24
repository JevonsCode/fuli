// Whether a confirmed term occurs in a task prompt, without a model. Both
// sides are identity keys (src/text/name-identity.js), so case, width and
// spacing do not matter. A term occurs as a whole term: where its first or
// last character is a letter, digit, mark or underscore of a script written
// with spaces between words (Latin, Cyrillic, ...), the neighbouring
// character on that side must not be one too, so "idev" does not occur in
// "idevelop" or "my_idev". Scripts written without spaces (Han, kana, Hangul)
// carry no word edges in plain text, so a term in them occurs wherever its
// characters do: "工时" occurs in "填今天的工时", and "idev" in "idev工时".

const WORD = /[\p{L}\p{N}\p{M}_]/u;
const UNSPACED = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]/u;

const spacedWord = (char) => char !== undefined && WORD.test(char) && !UNSPACED.test(char);
// A code point never spans more than two UTF-16 units.
const firstChar = (text, at) => [...text.slice(at, at + 2)][0];
const lastChar = (text, end) => [...text.slice(Math.max(0, end - 2), end)].at(-1);

export function termOccurs(text, term) {
  const opensWord = spacedWord(firstChar(term, 0));
  const closesWord = spacedWord(lastChar(term, term.length));
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
    if (opensWord && spacedWord(lastChar(text, at))) continue;
    if (closesWord && spacedWord(firstChar(text, at + term.length))) continue;
    return true;
  }
  return false;
}
