export function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

export function formatDate(value) {
  return new Date(value).toLocaleString();
}

export function humanPredicate(predicate) {
  if (predicate.startsWith('has_')) return predicate.slice(4);
  return predicate;
}

export function spaceKindLabel(kind) {
  if (kind === 'personal') return '个人';
  if (kind === 'public') return '公共';
  return kind;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function fillSelect(select, items, preferredValue = null) {
  const currentValue = select.value;
  select.replaceChildren(...items.map((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    return option;
  }));
  if (currentValue && items.some((item) => item.id === currentValue)) {
    select.value = currentValue;
  } else if (preferredValue && items.some((item) => item.id === preferredValue)) {
    select.value = preferredValue;
  } else if (items.length > 0) {
    select.value = items[0].id;
  }
}
