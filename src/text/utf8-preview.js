// The longest code-point prefix of value, plus mark (…), whose measured UTF-8
// size fits limit; never a partial code point. measure is the raw text by
// default; pass the serialized form to bound the bytes actually sent, or
// `text => text.length` for UTF-16 code units. mark '' cuts without one.
export function utf8Preview(value, limit, measure = text => Buffer.byteLength(text), mark = '…') {
  if (measure(value) <= limit) return value;
  let text = '';
  for (const point of value) {
    if (measure(text + point + mark) > limit) break;
    text += point;
  }
  return text + mark;
}
