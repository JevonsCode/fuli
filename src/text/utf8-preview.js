// The longest code-point prefix of value, plus …, whose measured UTF-8 size
// fits limit; never a partial code point. measure is the raw text by default;
// pass the serialized form to bound the bytes actually sent.
export function utf8Preview(value, limit, measure = text => Buffer.byteLength(text)) {
  if (measure(value) <= limit) return value;
  let text = '';
  for (const point of value) {
    if (measure(text + point + '…') > limit) break;
    text += point;
  }
  return text + '…';
}
