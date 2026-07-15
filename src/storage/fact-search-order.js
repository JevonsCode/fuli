export function compareSearchFacts(left, right) {
  return compareText(right.validAt, left.validAt) || compareText(left.id, right.id);
}

export function searchTextSortKey(value) {
  const text = String(value ?? '');
  const key = Buffer.allocUnsafe(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    key.writeUInt16BE(text.charCodeAt(index), index * 2);
  }
  return key;
}

function compareText(left, right) {
  const first = String(left ?? '');
  const second = String(right ?? '');
  return first === second ? 0 : (first < second ? -1 : 1);
}
