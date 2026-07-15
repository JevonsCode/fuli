export function rejectDuplicateValues(
  values,
  context,
  pathForIndex = (index) => [index],
) {
  const seen = new Set();

  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        path: pathForIndex(index),
        message: 'Duplicate values are not allowed',
      });
    }

    seen.add(value);
  });
}
