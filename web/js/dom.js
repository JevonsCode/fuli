export function el(tag, className = '', text = null, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  node.append(...children);
  return node;
}

export function statusChip(text, tone = '') {
  return el('span', `status-chip ${tone}`.trim(), text);
}
